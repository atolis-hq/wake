import type { EventEnvelope } from '@atolis-hq/eventing';
import {
  OrchestrationEventType,
  isWorkflowInstanceStream,
  observedRetryDescription,
  selectWorkflowOrchestrationEvent,
} from '../../../orchestration/index.js';
import { WorkStreamKind } from '../../../work/index.js';

export interface AuditJournal {
  readAll(afterGlobalPosition: number, limit?: number): Promise<readonly EventEnvelope[]>;
}

export interface AuditWork {
  get(workItemId: string): Promise<unknown>;
}

export interface AuditFact {
  readonly event: EventEnvelope['event'] & Omit<EventEnvelope, 'event'>;
  readonly retryCondition?: string;
  readonly causalLinks: { readonly causationId: string; readonly correlationId: string };
}

/** Reads canonical journal facts, not a projection, so it remains useful during rebuilds. */
export async function audit(
  journal: AuditJournal,
  work: AuditWork,
  workItemId: string,
): Promise<readonly AuditFact[]> {
  await work.get(workItemId);
  return auditFacts(journal, workItemId);
}

export async function auditFacts(
  journal: AuditJournal,
  workItemId: string,
): Promise<readonly AuditFact[]> {
  const events = await journal.readAll(0);
  const workflowStreams = new Set<string>(
    events.flatMap((event) => {
      const fact = selectWorkflowOrchestrationEvent(event);
      return fact?.event.eventType === OrchestrationEventType.InstanceStarted &&
        fact.event.payload.workItemId === workItemId
        ? [fact.stream.id]
        : [];
    }),
  );
  return events
    .filter(
      (event) =>
        (event.stream.kind === WorkStreamKind.WorkItem && event.stream.id === workItemId) ||
        (isWorkflowInstanceStream(event.stream) && workflowStreams.has(event.stream.id)),
    )
    .map((event) => ({
      ...retryDescription(event),
      event: {
        ...event.event,
        stream: event.stream,
        recordedAt: event.recordedAt,
        sequence: event.sequence,
        globalPosition: event.globalPosition,
      },
      causalLinks: {
        causationId: event.event.causationId,
        correlationId: event.event.correlationId,
      },
    }));
}

function retryDescription(event: EventEnvelope): { retryCondition?: string } {
  const fact = selectWorkflowOrchestrationEvent(event);
  if (
    fact?.event.eventType === OrchestrationEventType.SignalWaitStarted &&
    fact.event.payload.observed !== undefined
  )
    return { retryCondition: observedRetryDescription(fact.event.payload.observed) };
  if (
    fact?.event.eventType === OrchestrationEventType.ObservedStateRetryRecorded &&
    fact.event.payload.exhausted
  )
    return { retryCondition: observedRetryDescription([], true) };
  return {};
}
