import type { ViewSnapshotRecord, ViewSnapshotStore } from '@atolis-hq/eventing';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from './file-projection-store.js';
import { projectionStorageAddress } from './storage-name.js';

interface Advance {
  readonly valuePosition: number;
  readonly position: number;
  readonly anchorEventId: string;
}

/**
 * One JSON file per view, replaced atomically; anything unreadable counts as
 * absent. A small sidecar records how far an unchanged value has been advanced,
 * so a large, rarely-changing snapshot is not rewritten for every journal move.
 */
export class FileViewSnapshotStore implements ViewSnapshotStore {
  constructor(private readonly root: string) {}

  async load(viewName: string): Promise<ViewSnapshotRecord | null> {
    const record = await readJson(this.path(viewName, ''));
    if (!isRecord(record, viewName)) return null;
    const advance = await readJson(this.path(viewName, '.head'));
    if (!isAdvance(advance) || advance.valuePosition !== record.position) return record;
    if (advance.position <= record.position) return record;
    return {
      ...record,
      position: advance.position,
      anchorEventId: advance.anchorEventId,
      valuePosition: record.position,
    };
  }

  async save(record: ViewSnapshotRecord): Promise<void> {
    await atomicJson(this.path(record.viewName, ''), record);
  }

  async advance(
    viewName: string,
    valuePosition: number,
    position: number,
    anchorEventId: string,
  ): Promise<void> {
    const advance: Advance = { valuePosition, position, anchorEventId };
    await atomicJson(this.path(viewName, '.head'), advance);
  }

  private path(viewName: string, suffix: string): string {
    return join(this.root, `${projectionStorageAddress(viewName)}${suffix}.json`);
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function isAdvance(value: unknown): value is Advance {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.valuePosition === 'number' &&
    typeof record.position === 'number' &&
    typeof record.anchorEventId === 'string'
  );
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
