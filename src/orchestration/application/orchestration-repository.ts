import { foldedJournalView, type EventJournal, type JournalView } from '@atolis-hq/eventing';
import type { DeliveryCompletionBlock } from '../contracts/delivery.js';
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

export type ListedInstance = {
  readonly sequence: number;
  readonly view: WorkflowInstanceView | null;
};

type JournalEvent = Awaited<ReturnType<EventJournal['readAll']>>[number];

export interface OrchestrationSnapshot {
  readonly instances: readonly ListedInstance[];
  readonly events: readonly WorkflowOrchestrationEvent[];
  readonly inherited: ReadonlyMap<string, readonly WorkflowOrchestrationEvent[]>;
  readonly deferredInstanceIds: ReadonlySet<string>;
}

// Everything below is maintained by folding only the events after the position
// already held (see foldedJournalView), so a resident tick that reads workflow
// state pays for what changed, not for every event ever recorded. Maps and
// arrays are replaced, never mutated, because callers hold snapshots across awaits.
interface OrchestrationState extends OrchestrationSnapshot {
  /** Raw event count per instance stream; matches what readStream(...).length reports. */
  readonly sequences: ReadonlyMap<string, number>;
  /** Owned events appended on the instance's own stream. */
  readonly own: ReadonlyMap<string, readonly WorkflowOrchestrationEvent[]>;
  /** Own events plus reservations other instances made on this instance's behalf. */
  readonly grouped: ReadonlyMap<string, readonly WorkflowOrchestrationEvent[]>;
  readonly listedById: ReadonlyMap<string, ListedInstance>;
  /**
   * Instances whose history cannot be decoded or folded. A malformed event must
   * fail only its own instance's load, as a per-stream read did; list-based
   * reads still fail loudly, as the whole-journal derivation did.
   */
  readonly failures: ReadonlyMap<string, unknown>;
}

const emptyState: OrchestrationState = {
  failures: new Map(),
  instances: [],
  events: [],
  inherited: new Map(),
  deferredInstanceIds: new Set(),
  sequences: new Map(),
  own: new Map(),
  grouped: new Map(),
  listedById: new Map(),
};

export class OrchestrationRepository {
  private readonly state: JournalView<OrchestrationState>;

  constructor(
    private readonly journal: EventJournal,
    private readonly completionBlock?: (id: string) => Promise<DeliveryCompletionBlock | undefined>,
  ) {
    this.state = foldedJournalView(journal, { initial: emptyState, extend: extendState });
  }

  async load(id: string) {
    const { events: own, sequence } = await this.history(id);
    const inherited = ((await this.state.get()).inherited.get(id) ?? []).filter((entry) => {
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

  snapshot(): Promise<OrchestrationSnapshot> {
    return this.healthyState();
  }

  async events(): Promise<readonly WorkflowOrchestrationEvent[]> {
    return (await this.healthyState()).events;
  }

  /** Workflow instances that hold at least one deferred signal. */
  async instancesWithDeferredSignals(): Promise<ReadonlySet<string>> {
    return (await this.healthyState()).deferredInstanceIds;
  }

  async history(id: string) {
    const state = await this.state.get();
    if (state.failures.has(id)) throw state.failures.get(id);
    return { sequence: state.sequences.get(id) ?? 0, events: state.own.get(id) ?? [] };
  }

  /** The state for reads that span every instance, which fail while any instance is malformed. */
  private async healthyState(): Promise<OrchestrationState> {
    const state = await this.state.get();
    for (const failure of state.failures.values()) throw failure;
    return state;
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
    if (drafts.some((draft) => draft.eventType === OrchestrationEventType.InstanceCompleted)) {
      const block = await this.completionBlock?.(id);
      if (block !== undefined)
        drafts = drafts.map((draft) =>
          draft.eventType === OrchestrationEventType.InstanceCompleted
            ? { ...draft, eventType: OrchestrationEventType.InstanceBlocked, payload: block }
            : draft,
        );
    }
    const events = await this.journal.appendToStream(
      workflowInstanceStream(workflowInstanceId(id)),
      sequence,
      drafts,
    );
    return events.map(decodeOrchestrationEvent).filter(isWorkflowEvent);
  }

  async list(): Promise<readonly ListedInstance[]> {
    return (await this.healthyState()).instances;
  }
}

function isWorkflowEvent(
  event: ReturnType<typeof decodeOrchestrationEvent>,
): event is WorkflowOrchestrationEvent {
  return isWorkflowInstanceStream(event.stream);
}

/** Refolds only the touched instances; a fold error fails that instance alone. */
function refoldTouched(
  touched: ReadonlySet<string>,
  previous: ReadonlyMap<string, ListedInstance>,
  sequences: ReadonlyMap<string, number>,
  grouped: ReadonlyMap<string, readonly WorkflowOrchestrationEvent[]>,
  failures: Map<string, unknown>,
): Map<string, ListedInstance> {
  const listedById = new Map(previous);
  for (const id of touched) {
    // A parent named by a reservation may not have a stream of its own yet.
    if (!sequences.has(id)) continue;
    try {
      listedById.set(id, {
        sequence: sequences.get(id)!,
        view: foldWorkflowInstance(grouped.get(id) ?? []),
      });
    } catch (error) {
      listedById.delete(id);
      if (!failures.has(id)) failures.set(id, error);
    }
  }
  return listedById;
}

/** A malformed event poisons only the instance whose stream holds it. */
function decodeIsolated(
  raw: JournalEvent,
  instanceId: string,
  failures: Map<string, unknown>,
): WorkflowOrchestrationEvent | null {
  try {
    return selectWorkflowOrchestrationEvent(raw);
  } catch (error) {
    if (!failures.has(instanceId)) failures.set(instanceId, error);
    return null;
  }
}

/** The parent instance a child-stream DelegationReserved fact is recorded for. */
function reservingParent(event: WorkflowOrchestrationEvent): string | undefined {
  return event.event.eventType === OrchestrationEventType.DelegationReserved &&
    event.event.payload.parentWorkflowInstanceId !== event.stream.id
    ? event.event.payload.parentWorkflowInstanceId
    : undefined;
}

// `sequence` counts every event on the stream, matching readStream, while the
// fold sees only owned orchestration events. A DelegationReserved fact recorded
// on a child's stream also belongs to the parent's group, in journal order.
function extendState(
  state: OrchestrationState,
  events: readonly JournalEvent[],
): OrchestrationState {
  const sequences = new Map(state.sequences);
  const own = new Map(state.own);
  const grouped = new Map(state.grouped);
  const inherited = new Map(state.inherited);
  const deferred = new Set(state.deferredInstanceIds);
  const failures = new Map(state.failures);
  const added: WorkflowOrchestrationEvent[] = [];
  const touched = new Set<string>();
  // Arrays carried over from earlier states are copied on first touch, then
  // extended in place for the rest of this fold.
  const fresh = new Set<readonly WorkflowOrchestrationEvent[]>();
  const push = (
    map: Map<string, readonly WorkflowOrchestrationEvent[]>,
    key: string,
    event: WorkflowOrchestrationEvent,
  ) => {
    let list = map.get(key) as WorkflowOrchestrationEvent[] | undefined;
    if (list === undefined || !fresh.has(list)) {
      list = [...(list ?? [])];
      fresh.add(list);
      map.set(key, list);
    }
    list.push(event);
  };
  for (const raw of events) {
    if (!isWorkflowInstanceStream(raw.stream)) continue;
    const id = raw.stream.id;
    sequences.set(id, (sequences.get(id) ?? 0) + 1);
    touched.add(id);
    const event = decodeIsolated(raw, id, failures);
    if (event === null) continue;
    added.push(event);
    push(own, id, event);
    push(grouped, id, event);
    if (event.event.eventType === OrchestrationEventType.SignalDeferred) deferred.add(id);
    const parent = reservingParent(event);
    if (parent !== undefined) {
      push(grouped, parent, event);
      push(inherited, parent, event);
      touched.add(parent);
    }
  }
  if (touched.size === 0) return state;
  const listedById = refoldTouched(touched, state.listedById, sequences, grouped, failures);
  return {
    failures,
    instances: [...listedById.values()],
    events: added.length === 0 ? state.events : [...state.events, ...added],
    inherited,
    deferredInstanceIds: deferred,
    sequences,
    own,
    grouped,
    listedById,
  };
}
