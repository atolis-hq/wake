import { z } from 'zod';
import { ActivityOutcomeKind } from '../contracts/vocabulary.js';

import type { EventJournal } from '../../kernel/index.js';
import { BuiltInResourceCapability, resourceStream } from '../../resources/index.js';
import { workItemStream } from '../../work/index.js';
import type {
  ActivityDefinition,
  ActivityExecutionContext,
  ActivityInvocation,
} from '../contracts/activity.js';
import { ActivityEventType } from '../contracts/events.js';
import { ActivityExecutionKind, BuiltInActivityName } from '../contracts/vocabulary.js';
import {
  pullRequestOutcomeSchema,
  pullRequestTargetSchema,
  resolvePrimaryCapability,
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
import { decidePullRequestAuthority } from './policy.js';

const inputSchema: z.ZodType<PullRequestApproveInput> = z
  .object({ target: pullRequestTargetSchema, body: z.string().optional() })
  .strict()
  .transform((input): PullRequestApproveInput =>
    input.body === undefined
      ? { target: input.target }
      : { target: input.target, body: input.body },
  );

export function createPullRequestApproveActivity(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender = createJournalIntentAppender(journal),
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
    ],
    resources: [],
    executionKind: ActivityExecutionKind.Deterministic,
    handler: {
      execute: (invocation, context) =>
        executeApproval(journal, pullRequests, appender, invocation, context),
    },
  };
}

async function executeApproval(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender,
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
  const authority = await pullRequests.authorityInput(invocation.workItemId);
  const resource = resolvePrimaryCapability(
    invocation.resources,
    authority,
    invocation.workItemId,
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
