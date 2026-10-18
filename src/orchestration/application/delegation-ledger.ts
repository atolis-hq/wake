import {
  cachedJournalView,
  EventSourceKind,
  WrongExpectedSequenceError,
  type CachedJournalView,
  type CommandContext,
  type EventJournal,
} from '@atolis-hq/eventing';
import type { DelegationReservation, DelegationResult } from '../contracts/delegation.js';
import { selectWorkflowOrchestrationEvent } from '../contracts/event-decoder.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventData,
} from '../contracts/events.js';
import type { WorkflowInstanceId } from '../contracts/identifiers.js';
import { workflowInstanceStream } from '../contracts/streams.js';
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
  private readonly view: CachedJournalView<readonly WorkflowOrchestrationEvent[]>;

  constructor(
    private readonly journal: EventJournal,
    private readonly repository: OrchestrationRepository,
  ) {
    this.view = cachedJournalView(journal, (events) =>
      events.flatMap((event) => {
        const owned = selectWorkflowOrchestrationEvent(event);
        return owned === null ? [] : [owned];
      }),
    );
  }

  events(): Promise<readonly WorkflowOrchestrationEvent[]> {
    return this.view.get();
  }

  async reservations(): Promise<readonly DelegationReservation[]> {
    return reservationsOf(await this.events());
  }

  async fences(id: WorkflowInstanceId, activationId?: string): Promise<boolean> {
    const events = await this.events();
    return reservationsOf(events).some(
      (entry) =>
        entry.parentWorkflowInstanceId === id &&
        (activationId === undefined || entry.activationId === activationId) &&
        !isJoined(events, entry),
    );
  }

  /** Appends once per key, retrying optimistic-concurrency conflicts against fresh stream state. */
  async appendOnce(
    id: WorkflowInstanceId,
    context: CommandContext,
    key: string,
    input: DelegationDraft,
  ): Promise<void> {
    for (;;) {
      const events = await this.journal.readStream(workflowInstanceStream(id));
      if (events.some((event) => event.event.eventId === delegationEventId(id, key))) return;
      try {
        await this.repository.append(id, events.length, [delegationDraft(context, key, input, id)]);
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

export function selectedResults(
  events: readonly WorkflowOrchestrationEvent[],
  cohortId: string,
): readonly DelegationResult[] {
  return events.flatMap((event) =>
    event.event.eventType === OrchestrationEventType.DelegationResultSelected &&
    event.event.payload.cohortId === cohortId
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
