import type { FeedJournal } from './shared-journal-feed.js';
import {
  VIEW_SNAPSHOT_MIN_EVENTS,
  VIEW_SNAPSHOT_MIN_INTERVAL_MS,
  registeredViewSnapshotStore,
  type ViewPersistence,
} from './view-snapshot.js';

export interface ViewAnchor {
  readonly position: number;
  readonly eventId: string;
}

export interface RestoredView<Value> {
  readonly position: number;
  readonly value: Value;
  readonly eventId: string;
}

/** Loads a usable snapshot or null; any mismatch means "replay from the start". */
export async function restoreView<Value>(
  journal: FeedJournal,
  persistence: ViewPersistence<Value>,
  head: number,
): Promise<RestoredView<Value> | null> {
  const store = persistence.store ?? registeredViewSnapshotStore(journal);
  if (store === undefined) return null;
  try {
    const record = await store.load(persistence.name);
    if (
      record === null ||
      record.viewName !== persistence.name ||
      record.schemaVersion !== persistence.schemaVersion ||
      !Number.isSafeInteger(record.position) ||
      record.position < 1 ||
      record.position > head
    )
      return null;
    // One row proves the journal still holds the history this snapshot summarised.
    const [at] = await journal.readAll(record.position - 1, 1);
    if (at?.globalPosition !== record.position || at.event.eventId !== record.anchorEventId)
      return null;
    return {
      position: record.position,
      eventId: record.anchorEventId,
      value: persistence.codec.decode(record.value),
    };
  } catch {
    return null;
  }
}

/** Writes snapshots off the critical path: throttled, serialised, and never throwing. */
export class ViewSnapshotWriter<Value> {
  private persisted = 0;
  private lastAt = Number.NEGATIVE_INFINITY;
  private saving = false;

  constructor(
    private readonly journal: FeedJournal,
    private readonly persistence: ViewPersistence<Value>,
  ) {}

  /** Treat a restored position as already durable. */
  restored(position: number): void {
    this.persisted = position;
  }

  /** A restore moved the head backwards; what was persisted no longer describes it. */
  reset(): void {
    this.persisted = 0;
  }

  maybeSave(anchor: ViewAnchor | null, value: Value): void {
    const store = this.persistence.store ?? registeredViewSnapshotStore(this.journal);
    if (store === undefined || anchor === null || this.saving) return;
    const now = (this.persistence.now ?? Date.now)();
    if (
      anchor.position - this.persisted < (this.persistence.minEvents ?? VIEW_SNAPSHOT_MIN_EVENTS) ||
      now - this.lastAt < (this.persistence.minIntervalMs ?? VIEW_SNAPSHOT_MIN_INTERVAL_MS)
    )
      return;
    let encoded: unknown;
    try {
      encoded = this.persistence.codec.encode(value);
    } catch {
      return;
    }
    this.saving = true;
    this.lastAt = now;
    void store
      .save({
        viewName: this.persistence.name,
        schemaVersion: this.persistence.schemaVersion,
        position: anchor.position,
        anchorEventId: anchor.eventId,
        value: encoded,
      })
      .then(
        () => {
          this.persisted = anchor.position;
        },
        () => undefined,
      )
      .finally(() => {
        this.saving = false;
      });
  }
}
