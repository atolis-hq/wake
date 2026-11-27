import type { ViewSnapshotRecord, ViewSnapshotStore } from '../runtime/view-snapshot.js';

export class InMemoryViewSnapshotStore implements ViewSnapshotStore {
  private readonly records = new Map<string, ViewSnapshotRecord>();

  async load(viewName: string): Promise<ViewSnapshotRecord | null> {
    const record = this.records.get(viewName);
    return record === undefined ? null : structuredClone(record);
  }

  async save(record: ViewSnapshotRecord): Promise<void> {
    this.records.set(record.viewName, structuredClone(record));
  }

  /** Test hook: substitute a stored record to simulate corruption or age. */
  replace(viewName: string, record: ViewSnapshotRecord): void {
    this.records.set(viewName, record);
  }
}
