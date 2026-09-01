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
import { encodeStorageName } from './storage-name.js';

export class FileProcessorStateStore implements ProcessorStateStore {
  constructor(private readonly root: string) {}

  async read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null> {
    const paths = this.paths(consumer, key);
    const candidates = await this.readCandidates(paths);
    const stored = candidates.find(({ state }) =>
      matchesStateIdentity(state, paths.namespace, key),
    )?.state;
    if (stored !== undefined && stored !== null)
      return { consumer, key, value: stored.value as Value };
    return null;
  }

  async write<Value>(state: StoredProcessorState<Value>): Promise<void> {
    const paths = this.paths(state.consumer, state.key);
    await this.withStateLocks(candidatePaths(paths), async () => {
      const candidates = await this.readCandidates(paths);
      const current = candidateState(candidates, paths.current);
      if (matchesStateIdentity(current, paths.namespace, state.key))
        return atomicJson(paths.current, compatibleRecord(paths.namespace, state));
      const isolated = candidateState(candidates, paths.isolated);
      if (matchesStateIdentity(isolated, paths.namespace, state.key))
        return atomicJson(paths.isolated, compatibleRecord(paths.namespace, state));
      if (current === null)
        return atomicJson(paths.current, compatibleRecord(paths.namespace, state));
      if (isolated === null)
        return atomicJson(paths.isolated, compatibleRecord(paths.namespace, state));
      throw new Error(`Processor state paths are occupied for ${state.consumer}:${state.key}`);
    });
  }

  async delete(consumer: string, key: string): Promise<void> {
    const paths = this.paths(consumer, key);
    await this.withStateLocks(candidatePaths(paths), async () => {
      const candidates = await this.readCandidates(paths);
      for (const { path, state } of candidates) {
        if (matchesStateIdentity(state, paths.namespace, key)) await rm(path, { force: true });
      }
    });
  }

  private paths(consumer: string, key: string): ProcessorStatePaths {
    return processorStatePaths(this.root, consumer, key);
  }

  private async withStateLocks<Value>(paths: readonly string[], operation: () => Promise<Value>) {
    const locks = uniquePaths(paths)
      .map((path) => processorStateLockPath(this.root, path))
      .sort();
    return withLocks(locks, operation);
  }

  private async readCandidates(
    paths: ProcessorStatePaths,
  ): Promise<readonly ProcessorStateCandidate[]> {
    const candidates = await Promise.all(
      candidatePaths(paths).map(async (path) => ({ path, state: await readCompatibleState(path) })),
    );
    for (const { path, state } of candidates) {
      if (state !== null)
        assertCandidateProvenance(this.root, path, state, paths.namespace, paths.key);
    }
    return candidates;
  }
}

function legacyProcessorStatePath(root: string, namespace: string, key: string): string {
  return join(root, 'projections', encodeStorageName(namespace), `${encodeStorageName(key)}.json`);
}

function processorStateLockPath(root: string, path: string): string {
  return join(
    root,
    'locks',
    'processor-state',
    `${createHash('sha256').update(path).digest('hex')}.lock`,
  );
}

async function withLocks<Value>(
  paths: readonly string[],
  operation: () => Promise<Value>,
): Promise<Value> {
  const [path, ...rest] = paths;
  if (path === undefined) return operation();
  return withFileLock(path, () => withLocks(rest, operation), { waitMs: 5_000 });
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

function assertCandidateProvenance(
  root: string,
  path: string,
  stored: CompatibleProcessorStateRecord,
  namespace: string,
  key: string,
): void {
  if (matchesStateIdentity(stored, namespace, key)) return;
  if (legacyProcessorStatePath(root, stored.namespace, stored.key) === path) return;
  throw invalidProcessorStateRecord(path);
}

function compatibleRecord<Value>(
  namespace: string,
  state: StoredProcessorState<Value>,
): CompatibleProcessorStateRecord {
  return { namespace, key: state.key, lastGlobalPosition: 0, value: state.value };
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function candidatePaths(paths: ProcessorStatePaths): readonly string[] {
  return uniquePaths([paths.current, paths.isolated, paths.legacy]);
}

function candidateState(
  candidates: readonly ProcessorStateCandidate[],
  path: string,
): CompatibleProcessorStateRecord | null {
  const candidate = candidates.find((value) => value.path === path);
  if (candidate === undefined) throw new Error(`Missing processor state candidate for ${path}`);
  return candidate.state;
}

interface ProcessorStateCandidate {
  readonly path: string;
  readonly state: CompatibleProcessorStateRecord | null;
}
