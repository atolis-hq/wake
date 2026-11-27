import {
  foldedJournalView,
  type EventEnvelope,
  type EventJournal,
  type JournalView,
  type ViewPersistence,
  type ViewSnapshotCodec,
} from '@atolis-hq/eventing';
import { decodeWorkEvent, selectWorkEvent, type WorkEvent } from '../contracts/events.js';
import { isWorkItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';
import {
  deliveryAvailability,
  type DeliveryAvailability,
  type DeliveryWorkState,
} from '../domain/delivery-availability.js';
import { foldWorkItem } from '../domain/work-item.js';

/** Work state as of one point in the journal, answerable without further I/O. */
export interface DeliverySnapshot {
  get(id: string): DeliveryWorkState | null;
  /** True when the item's events could not be decoded or folded; it must be treated as held. */
  invalid(id: string): boolean;
  availability(id: string): DeliveryAvailability;
}

interface WorkIndexState {
  readonly streams: ReadonlyMap<string, readonly WorkEvent[]>;
  readonly items: ReadonlyMap<string, WorkItemView>;
  readonly invalid: ReadonlySet<string>;
}

/**
 * Every WorkItem folded once and extended as the journal grows. Batch readers
 * (dispatch, gating, capacity) ask for one snapshot and evaluate any number of
 * items against it, instead of reading each item's stream from storage. Each
 * journal read observes every append committed before it, so a snapshot
 * includes writes by other processes.
 */
export class WorkIndex {
  private readonly state: JournalView<WorkIndexState>;

  constructor(
    journal: Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>,
    snapshotThresholds: Pick<ViewPersistence<never>, 'minEvents' | 'minIntervalMs'> = {},
  ) {
    this.state = foldedJournalView(journal, {
      name: 'work-index',
      initial: { streams: new Map(), items: new Map(), invalid: new Set() },
      extend: extendWorkIndex,
      persist: {
        schemaVersion: 1,
        codec: workIndexCodec,
        ...snapshotThresholds,
      },
    });
  }

  async snapshot(): Promise<DeliverySnapshot> {
    const { items, invalid } = await this.state.get();
    const get = (id: string) => items.get(id) ?? null;
    return {
      get,
      invalid: (id) => invalid.has(id),
      availability: (id) => deliveryAvailability(id, get),
    };
  }
}

// Streams are persisted as decoded events and re-folded on load, so a snapshot
// can never disagree with the fold; items are derived, not stored.
const workIndexCodec: ViewSnapshotCodec<WorkIndexState> = {
  encode: (state) => ({
    streams: [...state.streams].map(([id, events]) => [id, events]),
    invalid: [...state.invalid],
  }),
  decode(raw) {
    const { streams: entries, invalid: invalidIds } = raw as {
      streams: [string, EventEnvelope[]][];
      invalid: string[];
    };
    const invalid = new Set(invalidIds);
    const streams = new Map<string, readonly WorkEvent[]>();
    const items = new Map<string, WorkItemView>();
    for (const [id, events] of entries) {
      const decoded = events.map((event) => decodeWorkEvent(event));
      streams.set(id, decoded);
      const view = invalid.has(id) ? null : foldWorkItem(decoded);
      if (view !== null) items.set(id, view);
    }
    return { streams, items, invalid };
  },
};

// A malformed stream poisons only its own item. That item is then unknown and
// held, rather than failing availability for every other item.
function extendWorkIndex(state: WorkIndexState, events: readonly EventEnvelope[]): WorkIndexState {
  const invalid = new Set(state.invalid);
  const added = new Map<string, WorkEvent[]>();
  for (const envelope of events) {
    if (!isWorkItemStream(envelope.stream) || invalid.has(envelope.stream.id)) continue;
    try {
      const event = selectWorkEvent(envelope);
      if (event === null) continue;
      const stream = added.get(envelope.stream.id);
      if (stream === undefined) added.set(envelope.stream.id, [event]);
      else stream.push(event);
    } catch {
      invalid.add(envelope.stream.id);
    }
  }
  const streams = new Map(state.streams);
  const items = new Map(state.items);
  for (const [id, more] of added) {
    if (invalid.has(id)) {
      items.delete(id);
      continue;
    }
    const all = [...(streams.get(id) ?? []), ...more];
    streams.set(id, all);
    try {
      const view = foldWorkItem(all);
      if (view !== null) items.set(id, view);
    } catch {
      invalid.add(id);
      items.delete(id);
    }
  }
  return { streams, items, invalid };
}
