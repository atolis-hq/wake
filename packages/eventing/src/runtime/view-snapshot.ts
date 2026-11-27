/**
 * A persisted journal-view snapshot is a rebuildable cache: deleting it never
 * changes behaviour, only the cost of the next catch-up.
 */
export interface ViewSnapshotRecord {
  readonly viewName: string;
  readonly schemaVersion: number;
  /** Global position of the last event folded into `value`. */
  readonly position: number;
  /** Event id at `position`; proves the journal still holds the history the snapshot summarised. */
  readonly anchorEventId: string;
  /** Codec output; must survive JSON. */
  readonly value: unknown;
  /** Set by a store that advanced `position` past the one `value` was written at. */
  readonly valuePosition?: number;
}

export interface ViewSnapshotStore {
  /** Null for a missing or unreadable snapshot; never throws for bad content. */
  load(viewName: string): Promise<ViewSnapshotRecord | null>;
  save(record: ViewSnapshotRecord): Promise<void>;
  /**
   * Moves the stored position forward without rewriting a `value` that has not
   * changed since `valuePosition`, so a view whose events are rare stays current
   * cheaply. A store that cannot do this omits it and the writer falls back to nothing.
   */
  advance?(
    viewName: string,
    valuePosition: number,
    position: number,
    anchorEventId: string,
  ): Promise<void>;
}

export interface ViewSnapshotCodec<Value> {
  encode(value: Value): unknown;
  /** Throws when `raw` is not a usable snapshot; the view then replays history instead. */
  decode(raw: unknown): Value;
}

export interface ViewPersistence<Value> {
  /** Bump when the fold or the encoded shape changes; older snapshots are then ignored. */
  readonly schemaVersion: number;
  readonly codec: ViewSnapshotCodec<Value>;
  /** Defaults to the store registered for the journal; no store means no persistence. */
  readonly store?: ViewSnapshotStore;
  readonly minEvents?: number;
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

export const VIEW_SNAPSHOT_MIN_EVENTS = 1_000;

export const VIEW_SNAPSHOT_MIN_INTERVAL_MS = 30_000;

const registered = new WeakMap<object, ViewSnapshotStore>();

/** Composition roots register one store per journal so views opt in by name only. */
export function registerViewSnapshotStore(journal: object, store: ViewSnapshotStore): void {
  registered.set(journal, store);
}

export function registeredViewSnapshotStore(journal: object): ViewSnapshotStore | undefined {
  return registered.get(journal);
}
