import { z } from 'zod';
import { ActivityOutcomeKind } from '../contracts/vocabulary.js';
import { MergeMethod } from './vocabulary.js';

import type { EventJournal } from '@atolis-hq/eventing';
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
import type { PullRequestActivityOutcome, PullRequestMergeInput } from './contracts.js';
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
import { decidePullRequestAuthority } from './policy.js';

const inputSchema: z.ZodType<PullRequestMergeInput> = z
  .object({
    target: pullRequestTargetSchema,
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
  });

export function createPullRequestMergeActivity(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender = createJournalIntentAppender(journal),
): ActivityDefinition<
  typeof BuiltInActivityName.PullRequestMerge,
  PullRequestMergeInput,
  PullRequestActivityOutcome
> {
  return {
    name: BuiltInActivityName.PullRequestMerge,
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
        executeMerge(journal, pullRequests, appender, invocation, context),
    },
  };
}

async function executeMerge(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender,
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
  const authority = await pullRequests.authorityInput(invocation.workItemId);
  const resource = resolvePrimaryCapability(
    invocation.resources,
    authority,
    invocation.workItemId,
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
  if (!decision.allowed) {
    const factStream = resourceStream(resource.resourceId);
    const denial = mergeDenied(decision.reason, command, {
      ...selectedDenialAudit(authority, resource.resourceId),
      method: invocation.input.method,
    });
    return claimAndCompleteDecision(journal, appender, invocation.activationId, MergeMethod.Merge, {
      decisionKind: 'denied',
      outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: decision.reason } },
      fact: denial,
      factStream,
    });
  }
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
