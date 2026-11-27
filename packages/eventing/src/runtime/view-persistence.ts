import type { FeedJournal } from './shared-journal-feed.js';
import {
  VIEW_SNAPSHOT_MIN_EVENTS,
  VIEW_SNAPSHOT_MIN_INTERVAL_MS,
  registeredViewSnapshotStore,
  type ViewPersistence,
  type ViewSnapshotStore,
} from './view-snapshot.js';

export interface ViewAnchor {
  readonly position: number;
  readonly eventId: string;
}

export interface RestoredView<Value> {
  readonly position: number;
  readonly valuePosition: number;
  readonly value: Value;
  readonly eventId: string;
}

/** Loads a usable snapshot or null; any mismatch means "replay from the start". */
export async function restoreView<Value>(
  journal: FeedJournal,
  name: string,
  persistence: ViewPersistence<Value>,
  head: number,
): Promise<RestoredView<Value> | null> {
  const store = persistence.store ?? registeredViewSnapshotStore(journal);
  if (store === undefined) return null;
  try {
    const record = await store.load(name);
    if (
      record === null ||
      record.viewName !== name ||
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
      valuePosition: record.valuePosition ?? record.position,
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
  /** The folded value the stored snapshot holds, and the position it was written at. */
  private stored: { readonly value: Value; readonly valuePosition: number } | undefined;

  constructor(
    private readonly journal: FeedJournal,
    private readonly name: string,
    private readonly persistence: ViewPersistence<Value>,
  ) {}

  /** Treat a restored snapshot as already durable. */
  restored(position: number, valuePosition: number, value: Value): void {
    this.persisted = position;
    this.stored = { value, valuePosition };
  }

  /** A restore moved the head backwards; what was persisted no longer describes it. */
  reset(): void {
    this.persisted = 0;
    this.stored = undefined;
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
    this.saving = true;
    this.lastAt = now;
    void this.write(store, anchor, value)
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

  private async write(store: ViewSnapshotStore, anchor: ViewAnchor, value: Value): Promise<void> {
    // Unchanged values (the fold returned the same object) skip the encode and rewrite.
    if (this.stored?.value === value && store.advance !== undefined) {
      await store.advance(this.name, this.stored.valuePosition, anchor.position, anchor.eventId);
      return;
    }
    const encoded = this.persistence.codec.encode(value);
    await store.save({
      viewName: this.name,
      schemaVersion: this.persistence.schemaVersion,
      position: anchor.position,
      anchorEventId: anchor.eventId,
      value: encoded,
    });
    this.stored = { value, valuePosition: anchor.position };
  }
}
