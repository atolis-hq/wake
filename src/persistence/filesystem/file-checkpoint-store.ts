import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckpointStore } from '../../kernel/index.js';
import { atomicJson, encode } from './file-projection-store.js';

export class FileCheckpointStore implements CheckpointStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}
  async load(consumer: string): Promise<number> {
    try {
      return await this.loadPath(consumer, this.path(consumer));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        return await this.loadPath(consumer, this.legacyPath(consumer));
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw legacyError;
      }
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
    await this.mutate(consumer, () =>
      Promise.all([
        rm(this.path(consumer), { force: true }),
        rm(this.legacyPath(consumer), { force: true }),
      ]).then(() => undefined),
    );
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
    return join(this.root, 'checkpoints', `v2-${encodeCheckpointConsumer(consumer)}.json`);
  }

  private legacyPath(consumer: string) {
    return join(this.root, 'checkpoints', `${encode(consumer)}.json`);
  }

  private async loadPath(consumer: string, path: string): Promise<number> {
    const value = JSON.parse(await readFile(path, 'utf8')) as {
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
  }
}

function encodeCheckpointConsumer(consumer: string): string {
  if (consumer.length === 0 || /[\\/]/.test(consumer))
    throw new Error('Storage name must not contain path separators');
  return Buffer.from(consumer, 'utf8').toString('base64url');
}
