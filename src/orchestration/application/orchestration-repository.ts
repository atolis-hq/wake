import { cachedJournalView, type CachedJournalView, type EventJournal } from '@atolis-hq/eventing';
import {
  decodeOrchestrationEvent,
  selectWorkflowOrchestrationEvent,
} from '../contracts/event-decoder.js';
import type {
  WorkflowOrchestrationEvent,
  WorkflowOrchestrationEventData,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { workflowInstanceId } from '../contracts/identifiers.js';
import { isWorkflowInstanceStream, workflowInstanceStream } from '../contracts/streams.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { foldWorkflowInstance } from '../domain/workflow-instance.js';

type ListedInstance = { readonly sequence: number; readonly view: WorkflowInstanceView | null };

type JournalEvent = Awaited<ReturnType<EventJournal['readAll']>>[number];

export class OrchestrationRepository {
  private readonly listed: CachedJournalView<{
    instances: readonly ListedInstance[];
    events: readonly WorkflowOrchestrationEvent[];
    inherited: ReadonlyMap<string, readonly WorkflowOrchestrationEvent[]>;
  }>;

  constructor(private readonly journal: EventJournal) {
    this.listed = cachedJournalView(journal, (events) => {
      const owned = events.flatMap((entry) => {
        const decoded = selectWorkflowOrchestrationEvent(entry);
        return decoded === null ? [] : [decoded];
      });
      return {
        instances: deriveList(events, owned),
        events: owned,
        inherited: inheritedReservations(owned),
      };
    });
  }

  async load(id: string) {
    const { events: own, sequence } = await this.history(id);
    const inherited = ((await this.listed.get()).inherited.get(id) ?? []).filter((entry) => {
      const fact = entry.event;
      if (
        entry.stream.id === id ||
        fact.eventType !== OrchestrationEventType.DelegationReserved ||
        fact.payload.parentWorkflowInstanceId !== id
      )
        return false;
      const cohortId = fact.payload.cohortId;
      return !own.some(
        (event) =>
          (event.event.eventType === OrchestrationEventType.DelegationJoined ||
            event.event.eventType === OrchestrationEventType.DelegationFailed) &&
          event.event.payload.cohortId === cohortId,
      );
    });
    return { sequence, view: foldWorkflowInstance([...own, ...inherited]) };
  }

  events(): Promise<readonly WorkflowOrchestrationEvent[]> {
    return this.listed.get().then((snapshot) => snapshot.events);
  }

  async history(id: string) {
    const raw = await this.journal.readStream(workflowInstanceStream(workflowInstanceId(id)));
    const events = raw.flatMap((entry) => {
      const owned = selectWorkflowOrchestrationEvent(entry);
      return owned === null ? [] : [owned];
    });
    return { sequence: raw.length, events };
  }

  async loadRequired(id: string) {
    const loaded = await this.load(id);
    if (loaded.view === null) throw new Error('WorkflowInstance does not exist');
    return { sequence: loaded.sequence, view: loaded.view };
  }

  async append(
    id: string,
    sequence: number,
    drafts: readonly WorkflowOrchestrationEventData[],
  ): Promise<readonly WorkflowOrchestrationEvent[]> {
    // Command and processor recovery may replay a completed append. Event IDs are
    // deterministic from the command causation, so acknowledge that exact intent
    // instead of appending a second copy after a crash between append and receipt.
    const existing = await this.journal.readStream(workflowInstanceStream(workflowInstanceId(id)));
    const existingIds = new Set(existing.map((event) => event.event.eventId));
    if (drafts.every((draft) => existingIds.has(draft.eventId)))
      return existing
        .filter((event) => drafts.some((draft) => draft.eventId === event.event.eventId))
        .map(decodeOrchestrationEvent)
        .filter(isWorkflowEvent);
    const events = await this.journal.appendToStream(
      workflowInstanceStream(workflowInstanceId(id)),
      sequence,
      drafts,
    );
    return events.map(decodeOrchestrationEvent).filter(isWorkflowEvent);
  }

  async list(): Promise<readonly ListedInstance[]> {
    return (await this.listed.get()).instances;
  }
}

function isWorkflowEvent(
  event: ReturnType<typeof decodeOrchestrationEvent>,
): event is WorkflowOrchestrationEvent {
  return isWorkflowInstanceStream(event.stream);
}

// `sequence` counts every event on the stream, matching readStream, while the
// fold sees only owned orchestration events — exactly what load() computes.
function deriveList(
  events: readonly JournalEvent[],
  owned: readonly WorkflowOrchestrationEvent[],
): readonly ListedInstance[] {
  const streams = new Map<string, JournalEvent[]>();
  for (const event of events) {
    if (!isWorkflowInstanceStream(event.stream)) continue;
    const existing = streams.get(event.stream.id);
    if (existing === undefined) streams.set(event.stream.id, [event]);
    else existing.push(event);
  }
  const grouped = new Map<string, WorkflowOrchestrationEvent[]>();
  const add = (id: string, event: WorkflowOrchestrationEvent) => {
    const group = grouped.get(id);
    if (group === undefined) grouped.set(id, [event]);
    else group.push(event);
  };
  for (const event of owned) {
    add(event.stream.id, event);
    if (
      event.event.eventType === OrchestrationEventType.DelegationReserved &&
      event.event.payload.parentWorkflowInstanceId !== event.stream.id
    )
      add(event.event.payload.parentWorkflowInstanceId, event);
  }
  return [...streams.values()].map((streamEvents) => ({
    sequence: streamEvents.length,
    view: foldWorkflowInstance(grouped.get(streamEvents[0]!.stream.id) ?? []),
  }));
}

function inheritedReservations(events: readonly WorkflowOrchestrationEvent[]) {
  const inherited = new Map<string, WorkflowOrchestrationEvent[]>();
  for (const entry of events) {
    if (entry.event.eventType !== OrchestrationEventType.DelegationReserved) continue;
    const id = entry.event.payload.parentWorkflowInstanceId;
    if (entry.stream.id === id) continue;
    const prior = inherited.get(id);
    if (prior === undefined) inherited.set(id, [entry]);
    else prior.push(entry);
  }
  return inherited;
}
