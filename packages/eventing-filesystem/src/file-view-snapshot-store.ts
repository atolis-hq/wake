import type { ViewSnapshotRecord, ViewSnapshotStore } from '@atolis-hq/eventing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './file-projection-store.js';
import { projectionStorageAddress } from './storage-name.js';

/** One JSON file per view, replaced atomically; anything unreadable counts as absent. */
export class FileViewSnapshotStore implements ViewSnapshotStore {
  constructor(private readonly root: string) {}

  async load(viewName: string): Promise<ViewSnapshotRecord | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path(viewName), 'utf8'));
    } catch {
      return null;
    }
    return isRecord(parsed, viewName) ? parsed : null;
  }

  async save(record: ViewSnapshotRecord): Promise<void> {
    await atomicJson(this.path(record.viewName), record);
  }

  private path(viewName: string): string {
    return join(this.root, `${projectionStorageAddress(viewName)}.json`);
  }
}

function isRecord(value: unknown, viewName: string): value is ViewSnapshotRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.viewName === viewName &&
    typeof record.schemaVersion === 'number' &&
    typeof record.position === 'number' &&
    typeof record.anchorEventId === 'string' &&
    'value' in record
  );
}
