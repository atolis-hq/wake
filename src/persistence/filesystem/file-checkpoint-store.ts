import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckpointStore } from '../../kernel/index.js';
import { atomicJson, encode } from './file-projection-store.js';

export class FileCheckpointStore implements CheckpointStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}
  async load(consumer: string): Promise<number> {
    try {
      const value = JSON.parse(await readFile(this.path(consumer), 'utf8')) as {
        consumer: string;
        globalPosition: number;
      };
      if (
        value.consumer !== consumer ||
        !Number.isSafeInteger(value.globalPosition) ||
        value.globalPosition < 0
      )
        throw new Error(`Invalid checkpoint: ${consumer}`);
      return value.globalPosition;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
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
    await this.mutate(consumer, () => rm(this.path(consumer), { force: true }));
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
    return join(this.root, 'checkpoints', `${encode(consumer)}.json`);
  }
}
