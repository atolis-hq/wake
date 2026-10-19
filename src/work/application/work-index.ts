import {
  cachedJournalView,
  type CachedJournalView,
  type EventEnvelope,
  type EventJournal,
} from '@atolis-hq/eventing';
import { selectWorkEvent, type WorkEvent } from '../contracts/events.js';
import { isWorkItemStream } from '../contracts/streams.js';
import type { WorkItemView } from '../contracts/views.js';
import {
  deliveryAvailability,
  type DeliveryAvailability,
  type DeliveryWorkState,
} from '../domain/delivery-availability.js';
import { foldWorkItem } from '../domain/work-item.js';

/** Work state as of one synchronisation point, answerable without further I/O. */
export interface DeliverySnapshot {
  get(id: string): DeliveryWorkState | null;
  availability(id: string): DeliveryAvailability;
}

/**
 * Every WorkItem folded once and kept in step with the journal. Batch readers
 * (dispatch, gating, capacity) ask for one snapshot and evaluate any number of
 * items against it, instead of reading each item's stream from storage.
 */
export class WorkIndex {
  private readonly items: CachedJournalView<ReadonlyMap<string, WorkItemView>>;

  constructor(journal: Pick<EventJournal, 'readAll' | 'latestGlobalPosition'>) {
    this.items = cachedJournalView(journal, deriveWorkItems);
  }

  /** Observes every append committed before the call, including from other hosts. */
  async snapshot(): Promise<DeliverySnapshot> {
    const items = await this.items.get({ fresh: true });
    const get = (id: string) => items.get(id) ?? null;
    return { get, availability: (id) => deliveryAvailability(id, get) };
  }
}

function deriveWorkItems(events: readonly EventEnvelope[]): ReadonlyMap<string, WorkItemView> {
  const streams = new Map<string, WorkEvent[]>();
  for (const envelope of events) {
    if (!isWorkItemStream(envelope.stream)) continue;
    const event = selectWorkEvent(envelope);
    if (event === null) continue;
    const stream = streams.get(envelope.stream.id);
    if (stream === undefined) streams.set(envelope.stream.id, [event]);
    else stream.push(event);
  }
  const items = new Map<string, WorkItemView>();
  for (const [id, stream] of streams) {
    try {
      const view = foldWorkItem(stream);
      if (view !== null) items.set(id, view);
    } catch {
      // A malformed stream leaves that item unknown, which delivery treats as
      // unavailable, rather than failing availability for every other item.
    }
  }
  return items;
}
