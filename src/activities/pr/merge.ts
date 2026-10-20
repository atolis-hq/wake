import { z } from 'zod';
import { ActivityOutcomeKind } from '../contracts/vocabulary.js';
import { readMergePolicyDenial } from './merge-policy-denial.js';
import { MergeMethod } from './vocabulary.js';

import type { CommandContext, EventJournal } from '@atolis-hq/eventing';
import {
  BuiltInResourceCapability,
  resourceStream,
  type ResourceId,
} from '../../resources/index.js';
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
import type {
  PullRequestActivityOutcome,
  PullRequestAuthorityDecision,
  PullRequestAuthorityInput,
  PullRequestMergeInput,
} from './contracts.js';
import {
  claimAndCompleteDecision,
  completeDecisionClaim,
  readDecisionClaim,
} from './decision-claim.js';
import { deliveryIntentRequested, mergeDenied } from './event-data.js';
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

export const pullRequestMergeInputSchema: z.ZodType<PullRequestMergeInput> = z
  .object({
    target: pullRequestTargetSchema,
    scope: parentDeliveryScopeSchema.optional(),
    method: z.enum([MergeMethod.Merge, MergeMethod.Squash, MergeMethod.Rebase]),
    requireChecks: z.boolean(),
    requireApproval: z.boolean().default(true),
    autoMerge: z.boolean().default(false),
    maxFilesChanged: z.number().int().positive().optional(),
    blockedPaths: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.requireApproval && !input.autoMerge)
      context.addIssue({
        code: 'custom',
        path: ['requireApproval'],
        message: 'requireApproval may be false only when autoMerge is true',
      });
    if (input.scope !== undefined && input.target !== ActivityResourceRole.Primary)
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'A delivery scope selects its own target; it cannot be combined with target',
      });
  });

export function createPullRequestMergeActivity(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender = createJournalIntentAppender(journal),
  parentActions?: ParentActionAuthorizer,
): ActivityDefinition<
  typeof BuiltInActivityName.PullRequestMerge,
  PullRequestMergeInput,
  PullRequestActivityOutcome
> {
  return {
    name: BuiltInActivityName.PullRequestMerge,
    inputSchema: pullRequestMergeInputSchema,
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
        executeMerge(journal, pullRequests, appender, parentActions, invocation, context),
    },
  };
}

async function denyByAuthority(
  { journal, appender }: { readonly journal: EventJournal; readonly appender: IntentAppender },
  invocation: ActivityInvocation<PullRequestMergeInput>,
  authority: PullRequestAuthorityInput,
  resourceId: ResourceId,
  decision: Extract<PullRequestAuthorityDecision, { readonly allowed: false }>,
  command: CommandContext,
): Promise<PullRequestActivityOutcome> {
  const audit = selectedDenialAudit(authority, resourceId);
  const policyDenial = readMergePolicyDenial({
    kind: ActivityOutcomeKind.Blocked,
    data: { reason: decision.reason },
  });
  const denial = mergeDenied(decision.reason, command, {
    ...audit,
    method: invocation.input.method,
  });
  return claimAndCompleteDecision(journal, appender, invocation.activationId, MergeMethod.Merge, {
    decisionKind: 'denied',
    outcome: {
      kind: ActivityOutcomeKind.Blocked,
      data: {
        reason: decision.reason,
        ...(policyDenial === null
          ? {}
          : {
              resourceId,
              ...(audit.revision === null ? {} : { revision: audit.revision }),
            }),
        ...(decision.policy === undefined ? {} : { policy: decision.policy }),
      },
    },
    fact: denial,
    factStream: resourceStream(resourceId),
  });
}

async function executeMerge(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender,
  parentActions: ParentActionAuthorizer | undefined,
  invocation: ActivityInvocation<PullRequestMergeInput>,
  context: ActivityExecutionContext,
): Promise<PullRequestActivityOutcome> {
  const requireApproval = invocation.input.requireApproval ?? true;
  const autoMerge = invocation.input.autoMerge ?? false;
  const command = activityCommandContext(
    invocation.activationId,
    invocation.orchestrationGroupId,
    context.occurredAt,
  );
  const prior = await readDecisionClaim(journal, invocation.activationId, MergeMethod.Merge);
  if (prior !== null) return completeDecisionClaim(journal, appender, prior);
  const parentTarget = await resolveParentTarget(
    parentActions,
    invocation,
    invocation.input.scope,
    ParentActionKind.Merge,
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
    BuiltInResourceCapability.Mergeable,
  );
  if (!resource.allowed) {
    const factStream = workItemStream(invocation.workItemId);
    const denial = mergeDenied(resource.reason, command, {
      ...selectionDenialAudit(invocation.input.target, resource.candidates),
      method: invocation.input.method,
    });
    return claimAndCompleteDecision(journal, appender, invocation.activationId, MergeMethod.Merge, {
      decisionKind: 'denied',
      outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: resource.reason } },
      fact: denial,
      factStream,
    });
  }
  const decision = decidePullRequestAuthority(authority, {
    target: { resourceId: resource.resourceId },
    requireAcceptedReview: requireApproval,
    requireChecks: invocation.input.requireChecks,
    allowPendingChecks: autoMerge,
    mergePolicy: {
      ...(invocation.input.maxFilesChanged === undefined
        ? {}
        : { maxFilesChanged: invocation.input.maxFilesChanged }),
      blockedPaths: invocation.input.blockedPaths,
    },
  });
  if (!decision.allowed)
    return denyByAuthority(
      { journal, appender },
      invocation,
      authority,
      resource.resourceId,
      decision,
      command,
    );
  const intent = deliveryIntentRequested(
    decision.resourceId,
    ActivityEventType.PrMergeRequested,
    {
      activationId: invocation.activationId,
      workflowInstanceId: invocation.workflowInstanceId,
      resourceId: decision.resourceId,
      revision: decision.revision,
      method: invocation.input.method,
      requireChecks: invocation.input.requireChecks,
      autoMerge,
      ...(scoped === undefined ? {} : { parent: scoped.context }),
    },
    command,
  );
  return claimAndCompleteDecision(journal, appender, invocation.activationId, MergeMethod.Merge, {
    decisionKind: 'requested',
    outcome: {
      kind: ActivityOutcomeKind.Waiting,
      data: { intentEventId: intent.eventId, signalKind: 'delivery-result' },
    },
    fact: intent,
    factStream: resourceStream(decision.resourceId),
  });
}
