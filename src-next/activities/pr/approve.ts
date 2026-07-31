import { ActivityOutcomeKind } from '../contracts/vocabulary.js';
import { z } from 'zod';

import type { ActivityDefinition } from '../contracts/activity.js';
import { ActivityExecutionKind, BuiltInActivityName } from '../contracts/vocabulary.js';
import { ActivityEventType } from '../contracts/events.js';
import type { EventJournal } from '../../kernel/index.js';
import { BuiltInResourceCapability, resourceStream } from '../../resources/index.js';
import { workItemStream } from '../../work/index.js';
import { approveDenied, deliveryIntentRequested } from './event-drafts.js';
import {
  activityCommandContext,
  createJournalIntentAppender,
  type IntentAppender,
} from './intent.js';
import type { PullRequestService } from './application.js';
import type { PullRequestActivityOutcome, PullRequestApproveInput } from './contracts.js';
import {
  pullRequestOutcomeSchema,
  pullRequestTargetSchema,
  resolvePrimaryCapability,
  selectedDenialAudit,
  selectionDenialAudit,
} from './activity-support.js';
import {
  claimDecision,
  completeDecisionClaim,
  readDecisionClaim,
  type PullRequestDecision,
} from './decision-claim.js';
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
      async execute(invocation, context) {
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
          const stream = workItemStream(invocation.workItemId);
          const denial = approveDenied(stream, resource.reason, command, {
            ...selectionDenialAudit(invocation.input.target, resource.candidates),
            body: invocation.input.body ?? null,
          });
          return decide({
            decisionKind: 'denied',
            outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: resource.reason } },
            fact: denial,
          });
        }
        const decision = decidePullRequestAuthority(authority, {
          target: { resourceId: resource.resourceId },
          requireAcceptedReview: false,
          requireChecks: false,
        });
        if (!decision.allowed) {
          const stream = resourceStream(resource.resourceId);
          const denial = approveDenied(stream, decision.reason, command, {
            ...selectedDenialAudit(authority, resource.resourceId),
            body: invocation.input.body ?? null,
          });
          return decide({
            decisionKind: 'denied',
            outcome: { kind: ActivityOutcomeKind.Blocked, data: { reason: decision.reason } },
            fact: denial,
          });
        }
        const intent = deliveryIntentRequested(
          decision.resourceId,
          ActivityEventType.PrApproveRequested,
          {
            activationId: invocation.activationId,
            resourceId: decision.resourceId,
            revision: decision.revision,
            body: invocation.input.body ?? null,
          },
          command,
        );
        return decide({
          decisionKind: 'requested',
          outcome: {
            kind: ActivityOutcomeKind.Waiting,
            data: { intentEventId: intent.eventId, signalKind: 'delivery-result' },
          },
          fact: intent,
        });

        async function decide(proposal: PullRequestDecision<'approve'>) {
          const claimed = await claimDecision(
            journal,
            invocation.activationId,
            'approve',
            proposal,
          );
          return completeDecisionClaim(journal, appender, claimed);
        }
      },
    },
  };
}
