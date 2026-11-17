import { ActivityOutcomeKind, agentActivityOutcomeSchema } from '../../activities/index.js';
import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';
import type { DelegationReviewRefresh } from '../contracts/delegation.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { delegationEventId } from './delegation-ledger.js';

/** New gates and inputs retire queued recovery reviews as well as their attestations. */
export function currentReviewRefreshes(events: readonly WorkflowOrchestrationEvent[]) {
  const current = new Map<
    WorkflowInstanceId,
    {
      id: WorkflowInstanceId;
      triggerId: string;
      request: DelegationReviewRefresh;
    }
  >();
  for (const { stream, event } of events) {
    if (event.eventType === Event.DelegationReviewRefreshRequested)
      current.set(stream.id, { id: stream.id, triggerId: event.eventId, request: event.payload });
    if (
      event.eventType === Event.DelegationInputsRefreshed ||
      (event.eventType === Event.SignalWaitStarted &&
        event.payload.signalKind === WatchGateVerdictSignal)
    )
      current.delete(stream.id);
  }
  return current;
}

export const ReviewRefreshVerdict = defineClosedVocabulary({
  Pending: 'pending',
  Accepted: 'accepted',
  Rejected: 'rejected',
  NoVerdict: 'no-verdict',
} as const);

export type ReviewRefreshVerdict = ValueOf<typeof ReviewRefreshVerdict>;

/** What a recovery review instance concluded; only Done and Rejected are review verdicts. */
export function reviewRefreshVerdict(review: WorkflowInstanceView | null): {
  readonly kind: ReviewRefreshVerdict;
  readonly reason?: string;
} {
  if (review === null || !terminal.has(review.status))
    return { kind: ReviewRefreshVerdict.Pending };
  const outcome = review.status === WorkflowStatus.Completed ? review.lastOutcome : undefined;
  if (outcome?.kind === ActivityOutcomeKind.Done) return { kind: ReviewRefreshVerdict.Accepted };
  if (outcome?.kind === ActivityOutcomeKind.Rejected)
    return { kind: ReviewRefreshVerdict.Rejected };
  const ended = outcome?.kind ?? review.status;
  return {
    kind: ReviewRefreshVerdict.NoVerdict,
    reason: `Fresh review ${review.workflowInstanceId} ended ${ended}${outcomeDetail(outcome)} without a verdict`,
  };
}

const terminal = new Set<WorkflowStatus>([
  WorkflowStatus.Completed,
  WorkflowStatus.Blocked,
  WorkflowStatus.Superseded,
]);

function outcomeDetail(outcome: WorkflowInstanceView['lastOutcome']) {
  const parsed = agentActivityOutcomeSchema.safeParse(outcome);
  if (!parsed.success || !('reason' in parsed.data.data)) return '';
  const { reason, message } = parsed.data.data;
  return ` (${reason}${message === undefined ? '' : ': ' + message})`;
}

/** Whether an event id is a review-refresh request for one child output head, on any attempt. */
export function isReviewRefreshAttempt(
  eventId: string,
  child: WorkflowInstanceId,
  subjectKey: string,
): boolean {
  const base = delegationEventId(child, subjectKey);
  const retry = `${base}:attempt:`;
  return (
    eventId === base || (eventId.startsWith(retry) && /^\d+$/.test(eventId.slice(retry.length)))
  );
}
