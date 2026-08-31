import type { CheckpointStore } from '@atolis-hq/eventing';

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, encode } from './file-projection-store.js';
import { encodeCheckpointStorageName } from './storage-name.js';

interface CheckpointRecord {
  readonly consumer: string;
  readonly globalPosition: number;
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}
  async load(consumer: string): Promise<number> {
    try {
      return await this.loadPath(consumer, this.path(consumer));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.loadLegacy(consumer);
    }
  }

  async save(consumer: string, globalPosition: number): Promise<void> {
    await this.mutate(consumer, async () => {
      if (globalPosition < (await this.load(consumer)))
        throw new Error(`Checkpoint regression for ${consumer}`);
      await atomicJson(this.path(consumer), { consumer, globalPosition });
    });
  }

  async reset(consumer: string): Promise<void> {
    await this.mutate(consumer, async () => {
      await rm(this.path(consumer), { force: true });
      await this.removeLegacyIfOwned(consumer);
    });
  }

  private async mutate<T>(consumer: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.mutations.get(consumer) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.mutations.set(consumer, current);
    try {
      return await current;
    } finally {
      if (this.mutations.get(consumer) === current) this.mutations.delete(consumer);
    }
  }

  private path(consumer: string) {
    return join(this.root, 'checkpoints', `v2-${encodeCheckpointStorageName(consumer)}.json`);
  }

  private legacyPath(consumer: string) {
    return join(this.root, 'checkpoints', `${encode(consumer)}.json`);
  }

  private async loadPath(consumer: string, path: string): Promise<number> {
    return checkpointPosition(consumer, await this.readCheckpoint(path));
  }

  private async loadLegacy(consumer: string): Promise<number> {
    try {
      const checkpoint = await this.readCheckpoint(this.legacyPath(consumer));
      if (checkpoint.consumer !== consumer) return 0;
      return checkpointPosition(consumer, checkpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  private async removeLegacyIfOwned(consumer: string): Promise<void> {
    try {
      const path = this.legacyPath(consumer);
      const checkpoint = await this.readCheckpoint(path);
      if (checkpoint.consumer === consumer) await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async readCheckpoint(path: string): Promise<CheckpointRecord> {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      !('consumer' in value) ||
      typeof value.consumer !== 'string' ||
      !('globalPosition' in value) ||
      typeof value.globalPosition !== 'number'
    )
      throw new Error('Invalid checkpoint record');
    return value as CheckpointRecord;
  }
}

function checkpointPosition(consumer: string, checkpoint: CheckpointRecord): number {
  if (
    checkpoint.consumer !== consumer ||
    !Number.isSafeInteger(checkpoint.globalPosition) ||
    checkpoint.globalPosition < 0
  )
    throw new Error(`Invalid checkpoint: ${consumer}`);
  return checkpoint.globalPosition;
}
