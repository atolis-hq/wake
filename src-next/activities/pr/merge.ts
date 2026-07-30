import { z } from 'zod';

import type { ActivityDefinition } from '../contracts/activity.js';
import { entityRef, type EventJournal } from '../../kernel/index.js';
import { deliveryIntentRequested, mergeDenied } from './event-drafts.js';
import {
  activityCommandContext,
  createJournalIntentAppender,
  type IntentAppender,
} from './intent.js';
import type { PullRequestService } from './application.js';
import type { PullRequestMergeInput } from './contracts.js';
import {
  pullRequestOutcomeSchema,
  pullRequestTargetSchema,
  resolvePrimaryCapability,
  selectedDenialAudit,
  selectionDenialAudit,
  workStream,
} from './activity-support.js';
import {
  claimDecision,
  completeDecisionClaim,
  readDecisionClaim,
  type PullRequestDecision,
} from './decision-claim.js';
import { decidePullRequestAuthority } from './policy.js';

const inputSchema: z.ZodType<PullRequestMergeInput> = z
  .object({
    target: pullRequestTargetSchema,
    method: z.enum(['merge', 'squash', 'rebase']),
    requireChecks: z.boolean(),
  })
  .strict();

export function createPullRequestMergeActivity(
  journal: EventJournal,
  pullRequests: PullRequestService,
  appender: IntentAppender = createJournalIntentAppender(journal),
): ActivityDefinition<PullRequestMergeInput> {
  return {
    name: 'pr.merge',
    inputSchema,
    outcomeSchema: pullRequestOutcomeSchema,
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(invocation, context) {
        const command = activityCommandContext(
          invocation.activationId,
          invocation.orchestrationGroupId,
          context.occurredAt,
        );
        const prior = await readDecisionClaim(journal, invocation.activationId, 'merge');
        if (prior !== null) return completeDecisionClaim(journal, appender, prior);
        const authority = await pullRequests.authorityInput(invocation.workItemId);
        const resource = resolvePrimaryCapability(
          invocation.resources,
          authority,
          invocation.workItemId,
          invocation.input.target,
          'mergeable',
        );
        if (!resource.allowed) {
          const stream = workStream(invocation.workItemId);
          const denial = mergeDenied(stream, resource.reason, command, {
            ...selectionDenialAudit(invocation.input.target, resource.candidates),
            method: invocation.input.method,
          });
          return decide({
            decisionKind: 'denied',
            outcome: { kind: 'blocked', data: { reason: resource.reason } },
            fact: denial,
          });
        }
        const decision = decidePullRequestAuthority(authority, {
          target: { resourceId: resource.resourceId },
          requireAcceptedReview: true,
          requireChecks: invocation.input.requireChecks,
        });
        if (!decision.allowed) {
          const stream = entityRef('resource', resource.resourceId);
          const denial = mergeDenied(stream, decision.reason, command, {
            ...selectedDenialAudit(authority, resource.resourceId),
            method: invocation.input.method,
          });
          return decide({
            decisionKind: 'denied',
            outcome: { kind: 'blocked', data: { reason: decision.reason } },
            fact: denial,
          });
        }
        const intent = deliveryIntentRequested(
          decision.resourceId,
          'pr.merge-requested',
          {
            activationId: invocation.activationId,
            resourceId: decision.resourceId,
            revision: decision.revision,
            method: invocation.input.method,
            requireChecks: invocation.input.requireChecks,
          },
          command,
        );
        return decide({
          decisionKind: 'requested',
          outcome: {
            kind: 'waiting',
            data: { intentEventId: intent.eventId, signalKind: 'delivery-result' },
          },
          fact: intent,
        });

        async function decide(proposal: PullRequestDecision) {
          const claimed = await claimDecision(journal, invocation.activationId, 'merge', proposal);
          return completeDecisionClaim(journal, appender, claimed);
        }
      },
    },
  };
}
