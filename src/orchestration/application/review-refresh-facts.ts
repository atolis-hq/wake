import type { DelegationReviewRefresh } from '../contracts/delegation.js';
import {
  OrchestrationEventType as Event,
  WatchGateVerdictSignal,
  type WorkflowOrchestrationEvent,
} from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';

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
