import { MergeMethod } from './vocabulary.js';
import { ActivityOutcomeKind } from '../contracts/vocabulary.js';
import { z } from 'zod';

import type {
  ActivityDefinition,
  ActivityExecutionContext,
  ActivityInvocation,
} from '../contracts/activity.js';
import { ActivityExecutionKind, BuiltInActivityName } from '../contracts/vocabulary.js';
import { ActivityEventType } from '../contracts/events.js';
import type { EventJournal } from '../../kernel/index.js';
import { BuiltInResourceCapability, resourceStream } from '../../resources/index.js';
import { workItemStream } from '../../work/index.js';
import { deliveryIntentRequested, mergeDenied } from './event-drafts.js';
import {
  activityCommandContext,
  createJournalIntentAppender,
  type IntentAppender,
} from './intent.js';
import type { PullRequestService } from './application.js';
import type { PullRequestActivityOutcome, PullRequestMergeInput } from './contracts.js';
import {
  pullRequestOutcomeSchema,
  pullRequestTargetSchema,
  resolvePrimaryCapability,
  selectedDenialAudit,
  selectionDenialAudit,
} from './activity-support.js';
import {
  claimAndCompleteDecision,
  completeDecisionClaim,
  readDecisionClaim,
} from './decision-claim.js';
import { decidePullRequestAuthority } from './policy.js';

const inputSchema: z.ZodType<PullRequestMergeInput> = z
  .object({
    target: pullRequestTargetSchema,
    method: z.enum([MergeMethod.Merge, MergeMethod.Squash, MergeMethod.Rebase]),
    requireChecks: z.boolean(),
    maxFilesChanged: z.number().int().positive().optional(),
    blockedPaths: z.array(z.string().min(1)).default([]),
  })
  .strict();

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
    const denial = mergeDenied(workItemStream(invocation.workItemId), resource.reason, command, {
      ...selectionDenialAudit(invocation.input.target, resource.candidates),
      method: invocation.input.method,
    });
    return claimAndCompleteDecision(journal, appender, invocation.activationId, MergeMethod.Merge, {
      decisionKind: 'denied',
      outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: resource.reason } },
      fact: denial,
    });
  }
  const decision = decidePullRequestAuthority(authority, {
    target: { resourceId: resource.resourceId },
    requireAcceptedReview: true,
    requireChecks: invocation.input.requireChecks,
    mergePolicy: {
      ...(invocation.input.maxFilesChanged === undefined
        ? {}
        : { maxFilesChanged: invocation.input.maxFilesChanged }),
      blockedPaths: invocation.input.blockedPaths,
    },
  });
  if (!decision.allowed) {
    const denial = mergeDenied(resourceStream(resource.resourceId), decision.reason, command, {
      ...selectedDenialAudit(authority, resource.resourceId),
      method: invocation.input.method,
    });
    return claimAndCompleteDecision(journal, appender, invocation.activationId, MergeMethod.Merge, {
      decisionKind: 'denied',
      outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: decision.reason } },
      fact: denial,
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
  });
}
