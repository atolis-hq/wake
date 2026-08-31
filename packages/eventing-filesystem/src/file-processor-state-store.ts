import type { ProcessorStateStore, StoredProcessorState } from '@atolis-hq/eventing';

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, encode } from './file-projection-store.js';
import { assertStorageName } from './storage-name.js';

interface CompatibleStateRecord {
  readonly namespace: string;
  readonly key: string;
  readonly lastGlobalPosition: number;
  readonly value: unknown;
}

export class FileProcessorStateStore implements ProcessorStateStore {
  constructor(private readonly root: string) {}

  async read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null> {
    try {
      const stored = JSON.parse(
        await readFile(this.path(consumer, key), 'utf8'),
      ) as CompatibleStateRecord;
      return { consumer, key, value: stored.value as Value };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write<Value>(state: StoredProcessorState<Value>): Promise<void> {
    await atomicJson(this.path(state.consumer, state.key), {
      namespace: this.namespace(state.consumer),
      key: state.key,
      lastGlobalPosition: 0,
      value: state.value,
    });
  }

  async delete(consumer: string, key: string): Promise<void> {
    await rm(this.path(consumer, key), { force: true });
  }

  private path(consumer: string, key: string): string {
    return join(
      this.root,
      'projections',
      encode(this.namespace(consumer)),
      `${encodeStateKey(key)}.json`,
    );
  }

  private namespace(consumer: string): string {
    assertStorageName(consumer);
    return `${consumer}:pending`;
  }
}

function encodeStateKey(key: string): string {
  assertStorageName(key);
  return encode(key);
}
