import {
  EventSourceKind,
  WrongExpectedSequenceError,
  type CommandContext,
} from '@atolis-hq/eventing';
import type { DelegationReservation, DelegationResult } from '../contracts/delegation.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventData,
} from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { workflowEventData } from '../domain/decision-events.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

type DelegationDraft = {
  [T in WorkflowOrchestrationEventData['eventType']]: Pick<
    Extract<WorkflowOrchestrationEventData, { eventType: T }>,
    'eventType' | 'payload'
  >;
}[WorkflowOrchestrationEventData['eventType']];

/** Deterministic event identity makes every delegation append replay-safe. */
export function delegationEventId(id: string, key: string): string {
  return `delegation:${id}:${key}`;
}

export function delegationDraft(
  context: CommandContext,
  key: string,
  input: DelegationDraft,
  id: string,
): WorkflowOrchestrationEventData {
  return workflowEventData({
    ...input,
    eventId: delegationEventId(id, key),
    occurredAt: context.occurredAt,
    correlationId: context.correlationId,
    causationId: context.commandId,
    actor: context.actor,
    source: { kind: EventSourceKind.Internal, id: 'delegation' },
  });
}

/** Read side and idempotent append helpers over the journal-owned delegation facts. */
export class DelegationLedger {
  constructor(private readonly repository: OrchestrationRepository) {}

  events(): Promise<readonly WorkflowOrchestrationEvent[]> {
    return this.repository.events();
  }

  async reservations(): Promise<readonly DelegationReservation[]> {
    return reservationsOf(await this.events());
  }

  /** Appends once per key, retrying optimistic-concurrency conflicts against fresh stream state. */
  async appendOnce(
    id: WorkflowInstanceId,
    context: CommandContext,
    key: string,
    input: DelegationDraft,
  ): Promise<void> {
    for (;;) {
      const { events, sequence } = await this.repository.history(id);
      if (events.some((event) => event.event.eventId === delegationEventId(id, key))) return;
      try {
        await this.repository.append(id, sequence, [delegationDraft(context, key, input, id)]);
        return;
      } catch (error) {
        if (!(error instanceof WrongExpectedSequenceError)) throw error;
      }
    }
  }
}

export function reservationsOf(
  events: readonly WorkflowOrchestrationEvent[],
): readonly DelegationReservation[] {
  return events.flatMap((event) =>
    event.event.eventType === OrchestrationEventType.DelegationReserved
      ? [event.event.payload]
      : [],
  );
}

export function isJoined(
  events: readonly WorkflowOrchestrationEvent[],
  reservation: DelegationReservation,
): boolean {
  return events.some(
    (event) =>
      event.stream.id === reservation.parentWorkflowInstanceId &&
      event.event.eventType === OrchestrationEventType.DelegationJoined &&
      event.event.payload.cohortId === reservation.cohortId,
  );
}

export function isSettled(
  events: readonly WorkflowOrchestrationEvent[],
  reservation: DelegationReservation,
): boolean {
  return (
    isJoined(events, reservation) ||
    events.some(
      (entry) =>
        entry.stream.id === reservation.parentWorkflowInstanceId &&
        entry.event.eventType === OrchestrationEventType.DelegationFailed &&
        entry.event.payload.cohortId === reservation.cohortId,
    )
  );
}

export function selectedResults(
  events: readonly WorkflowOrchestrationEvent[],
  reservation: DelegationReservation,
): readonly DelegationResult[] {
  const children = new Set(reservation.children.map((child) => child.workItemId));
  return events.flatMap((event) =>
    event.event.eventType === OrchestrationEventType.DelegationResultSelected &&
    event.event.payload.cohortId === reservation.cohortId &&
    children.has(event.event.payload.childWorkItemId)
      ? [event.event.payload]
      : [],
  );
}

export function reservedEvent(
  events: readonly WorkflowOrchestrationEvent[],
  reservation: DelegationReservation,
): WorkflowOrchestrationEvent {
  const found = events.find(
    (entry) =>
      entry.event.eventType === OrchestrationEventType.DelegationReserved &&
      entry.event.payload.rootWorkItemId === reservation.rootWorkItemId &&
      entry.event.payload.cohortId === reservation.cohortId,
  );
  if (found === undefined) throw new Error('Missing delegation reservation');
  return found;
}

/** Terminal membership is indexed once for a reconciliation pass, independent of history size. */
export function unsettledReservations(
  events: readonly WorkflowOrchestrationEvent[],
): readonly DelegationReservation[] {
  const settled = new Set(
    events.flatMap(({ event, stream }) =>
      event.eventType === OrchestrationEventType.DelegationJoined ||
      event.eventType === OrchestrationEventType.DelegationFailed
        ? [JSON.stringify([stream.id, event.payload.cohortId])]
        : [],
    ),
  );
  return reservationsOf(events).filter(
    (reservation) =>
      !settled.has(JSON.stringify([reservation.parentWorkflowInstanceId, reservation.cohortId])),
  );
}
