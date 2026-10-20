import { z } from 'zod';
import { ActivityOutcomeKind } from '../contracts/vocabulary.js';

import type { EventJournal } from '@atolis-hq/eventing';
import { BuiltInResourceCapability, resourceStream } from '../../resources/index.js';
import { workItemStream } from '../../work/index.js';
import type {
  ActivityDefinition,
  ActivityExecutionContext,
  ActivityInvocation,
} from '../contracts/activity.js';
import { ActivityEventType } from '../contracts/events.js';
import {
  ActivityExecutionKind,
  ActivityResourceRole,
  BuiltInActivityName,
} from '../contracts/vocabulary.js';
import {
  pullRequestOutcomeSchema,
  pullRequestTargetSchema,
  selectedDenialAudit,
  selectionDenialAudit,
} from './activity-support.js';
import type { PullRequestService } from './application.js';
import type { PullRequestActivityOutcome, PullRequestApproveInput } from './contracts.js';
import {
  claimAndCompleteDecision,
  completeDecisionClaim,
  readDecisionClaim,
} from './decision-claim.js';
import { approveDenied, deliveryIntentRequested } from './event-data.js';
import {
  activityCommandContext,
  createJournalIntentAppender,
  type IntentAppender,
} from './intent.js';
import {
  ParentActionKind,
  parentDeliveryScopeSchema,
  type ParentActionAuthorizer,
} from './parent-scope.js';
import { resolveActionResource, resolveParentTarget } from './parent-target.js';
import { decidePullRequestAuthority } from './policy.js';

const inputSchema: z.ZodType<PullRequestApproveInput> = z
  .object({
    target: pullRequestTargetSchema,
    body: z.string().optional(),
    scope: parentDeliveryScopeSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scope !== undefined && input.target !== ActivityResourceRole.Primary)
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'A delivery scope selects its own target; it cannot be combined with target',
      });
  })
  .transform((input): PullRequestApproveInput => ({
    target: input.target,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
  }));

export function createPullRequestApproveActivity(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender = createJournalIntentAppender(journal),
  parentActions?: ParentActionAuthorizer,
): ActivityDefinition<
  typeof BuiltInActivityName.PullRequestApprove,
  PullRequestApproveInput,
  PullRequestActivityOutcome
> {
  return {
    name: BuiltInActivityName.PullRequestApprove,
    inputSchema,
    outcomeSchema: pullRequestOutcomeSchema,
    outcomeKinds: [
      ActivityOutcomeKind.Waiting,
      ActivityOutcomeKind.Done,
      ActivityOutcomeKind.Blocked,
      ActivityOutcomeKind.Failed,
      ActivityOutcomeKind.Integrated,
    ],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      execute: (invocation, context) =>
        executeApproval(journal, pullRequests, appender, parentActions, invocation, context),
    },
  };
}

async function executeApproval(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender,
  parentActions: ParentActionAuthorizer | undefined,
  invocation: ActivityInvocation<PullRequestApproveInput>,
  context: ActivityExecutionContext,
): Promise<PullRequestActivityOutcome> {
  const command = activityCommandContext(
    invocation.activationId,
    invocation.orchestrationGroupId,
    context.occurredAt,
  );
  const prior = await readDecisionClaim(journal, invocation.activationId, 'approve');
  if (prior !== null) return completeDecisionClaim(journal, appender, prior);
  const parentTarget = await resolveParentTarget(
    parentActions,
    invocation,
    invocation.input.scope,
    ParentActionKind.Approve,
  );
  if (parentTarget.kind === 'fully-integrated')
    return { kind: ActivityOutcomeKind.Integrated, data: { complete: true } };
  const scoped = parentTarget.kind === 'target' ? parentTarget : undefined;
  const authority = await pullRequests.authorityInput(
    scoped?.context.ownerWorkItemId ?? invocation.workItemId,
  );
  const resource = resolveActionResource(
    parentTarget,
    authority,
    invocation,
    invocation.input.target,
    BuiltInResourceCapability.Approvable,
  );
  if (!resource.allowed) {
    const factStream = workItemStream(invocation.workItemId);
    const denial = approveDenied(resource.reason, command, {
      ...selectionDenialAudit(invocation.input.target, resource.candidates),
      body: invocation.input.body ?? null,
    });
    return claimAndCompleteDecision(journal, appender, invocation.activationId, 'approve', {
      decisionKind: 'denied',
      outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: resource.reason } },
      fact: denial,
      factStream,
    });
  }
  const decision = decidePullRequestAuthority(authority, {
    target: { resourceId: resource.resourceId },
    requireAcceptedReview: false,
    requireChecks: false,
  });
  if (!decision.allowed) {
    const factStream = resourceStream(resource.resourceId);
    const denial = approveDenied(decision.reason, command, {
      ...selectedDenialAudit(authority, resource.resourceId),
      body: invocation.input.body ?? null,
    });
    return claimAndCompleteDecision(journal, appender, invocation.activationId, 'approve', {
      decisionKind: 'denied',
      outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: decision.reason } },
      fact: denial,
      factStream,
    });
  }
  const intent = deliveryIntentRequested(
    decision.resourceId,
    ActivityEventType.PrApproveRequested,
    {
      activationId: invocation.activationId,
      workflowInstanceId: invocation.workflowInstanceId,
      resourceId: decision.resourceId,
      revision: decision.revision,
      body: invocation.input.body ?? null,
      ...(scoped === undefined ? {} : { parent: scoped.context }),
    },
    command,
  );
  return claimAndCompleteDecision(journal, appender, invocation.activationId, 'approve', {
    decisionKind: 'requested',
    outcome: {
      kind: ActivityOutcomeKind.Waiting,
      data: { intentEventId: intent.eventId, signalKind: 'delivery-result' },
    },
    fact: intent,
    factStream: resourceStream(decision.resourceId),
  });
}
