import type { ProcessorStateStore, StoredProcessorState } from '@atolis-hq/eventing';

import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from './file-lock.js';
import { atomicJson } from './file-projection-store.js';
import { processorStatePaths, type ProcessorStatePaths } from './processor-state-paths.js';
import {
  isCompatibleProcessorStateRecord,
  type CompatibleProcessorStateRecord,
} from './processor-state-record.js';

export class FileProcessorStateStore implements ProcessorStateStore {
  constructor(private readonly root: string) {}

  async read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null> {
    const paths = this.paths(consumer, key);
    const stored = await this.readState(paths);
    if (stored !== null && matchesStateIdentity(stored, paths.namespace, key))
      return { consumer, key, value: stored.value as Value };
    return null;
  }

  async write<Value>(state: StoredProcessorState<Value>): Promise<void> {
    const paths = this.paths(state.consumer, state.key);
    await this.withStateLock(paths.current, async () => {
      const current = await this.readState(paths);
      if (matchesStateIdentity(current, paths.namespace, state.key))
        return atomicJson(paths.current, compatibleRecord(paths.namespace, state));
      if (current === null)
        return atomicJson(paths.current, compatibleRecord(paths.namespace, state));
      throw new Error(`Processor state paths are occupied for ${state.consumer}:${state.key}`);
    });
  }

  async delete(consumer: string, key: string): Promise<void> {
    const paths = this.paths(consumer, key);
    await this.withStateLock(paths.current, async () => {
      const state = await this.readState(paths);
      if (matchesStateIdentity(state, paths.namespace, key))
        await rm(paths.current, { force: true });
    });
  }

  private paths(consumer: string, key: string): ProcessorStatePaths {
    return processorStatePaths(this.root, consumer, key);
  }

  private async withStateLock<Value>(path: string, operation: () => Promise<Value>) {
    return withFileLock(processorStateLockPath(this.root, path), operation, { waitMs: 5_000 });
  }

  private async readState(
    paths: ProcessorStatePaths,
  ): Promise<CompatibleProcessorStateRecord | null> {
    const state = await readCompatibleState(paths.current);
    if (state !== null && !matchesStateIdentity(state, paths.namespace, paths.key))
      throw invalidProcessorStateRecord(paths.current);
    return state;
  }
}

function processorStateLockPath(root: string, path: string): string {
  return join(
    root,
    'locks',
    'processor-state',
    `${createHash('sha256').update(path).digest('hex')}.lock`,
  );
}

async function readCompatibleState(path: string): Promise<CompatibleProcessorStateRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch (error) {
    throw invalidProcessorStateRecord(path, error);
  }
  if (!isCompatibleProcessorStateRecord(stored)) throw invalidProcessorStateRecord(path);
  return stored;
}

function invalidProcessorStateRecord(path: string, cause?: unknown): Error {
  return new Error(`Invalid processor state record at ${path}`, { cause });
}

function matchesStateIdentity(
  stored: CompatibleProcessorStateRecord | null,
  namespace: string,
  key: string,
): boolean {
  return stored?.namespace === namespace && stored.key === key;
}

function compatibleRecord<Value>(
  namespace: string,
  state: StoredProcessorState<Value>,
): CompatibleProcessorStateRecord {
  return { namespace, key: state.key, lastGlobalPosition: 0, value: state.value };
}
