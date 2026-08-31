import type { ProcessorStateStore, StoredProcessorState } from '@atolis-hq/eventing';

import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withFileLock } from './file-lock.js';
import { atomicJson, encode } from './file-projection-store.js';
import { assertStorageName } from './storage-name.js';

interface CompatibleStateRecord {
  readonly namespace: string;
  readonly key: string;
  readonly lastGlobalPosition: number;
  readonly value: unknown;
}

const pendingNamespaceSuffix = ':pending';

export class FileProcessorStateStore implements ProcessorStateStore {
  constructor(private readonly root: string) {}

  async read<Value>(consumer: string, key: string): Promise<StoredProcessorState<Value> | null> {
    const paths = this.paths(consumer, key);
    for (const path of uniquePaths([paths.current, paths.isolated, paths.legacy])) {
      const stored = await readCompatibleState(path);
      if (matchesStateIdentity(stored, paths.namespace, key))
        return { consumer, key, value: stored.value as Value };
    }
    return null;
  }

  async write<Value>(state: StoredProcessorState<Value>): Promise<void> {
    const paths = this.paths(state.consumer, state.key);
    await this.withStateLocks([paths.current, paths.isolated], async () => {
      const current = await readCompatibleState(paths.current);
      if (matchesStateIdentity(current, paths.namespace, state.key))
        return atomicJson(paths.current, compatibleRecord(paths.namespace, state));
      const isolated = await readCompatibleState(paths.isolated);
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
    await this.withStateLocks([paths.current, paths.isolated, paths.legacy], async () => {
      for (const path of uniquePaths([paths.current, paths.isolated, paths.legacy])) {
        const stored = await readCompatibleState(path);
        if (matchesStateIdentity(stored, paths.namespace, key)) await rm(path, { force: true });
      }
    });
  }

  private paths(consumer: string, key: string): ProcessorStatePaths {
    const namespace = this.namespace(consumer);
    const currentNamespace = encodeProcessorStateName(namespace);
    const currentKey = encodeProcessorStateName(key);
    return {
      namespace,
      current: processorStatePath(this.root, currentNamespace, currentKey),
      isolated: processorStatePath(
        this.root,
        `%processor-state-${currentNamespace}`,
        `%processor-state-${currentKey}`,
      ),
      legacy: processorStatePath(this.root, encode(namespace), encodeStateKey(key)),
    };
  }

  private namespace(consumer: string): string {
    assertStorageName(consumer);
    return `${consumer}${pendingNamespaceSuffix}`;
  }

  private async withStateLocks<Value>(paths: readonly string[], operation: () => Promise<Value>) {
    const locks = uniquePaths(paths)
      .map((path) => processorStateLockPath(this.root, path))
      .sort();
    return withLocks(locks, operation);
  }
}

function encodeStateKey(key: string): string {
  assertStorageName(key);
  return encode(key);
}

function encodeProcessorStateName(value: string): string {
  assertStorageName(value);
  return encodeURIComponent(value)
    .replace(/~/g, '%7E')
    .replace(/%(?!7E)/g, '~')
    .replace(/\./g, '~2E');
}

function processorStatePath(root: string, namespace: string, key: string): string {
  return join(root, 'projections', namespace, `${key}.json`);
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

async function readCompatibleState(path: string): Promise<CompatibleStateRecord | null> {
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
  if (!isCompatibleStateRecord(stored)) throw invalidProcessorStateRecord(path);
  return stored;
}

function isCompatibleStateRecord(value: unknown): value is CompatibleStateRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.namespace === 'string' &&
    typeof record.key === 'string' &&
    isProcessorStateNamespace(record.namespace) &&
    isStorageName(record.key) &&
    Number.isInteger(record.lastGlobalPosition) &&
    record.lastGlobalPosition === 0 &&
    Object.hasOwn(record, 'value')
  );
}

function isProcessorStateNamespace(namespace: string): boolean {
  if (!namespace.endsWith(pendingNamespaceSuffix)) return false;
  return isStorageName(namespace.slice(0, -pendingNamespaceSuffix.length));
}

function isStorageName(value: string): boolean {
  try {
    assertStorageName(value);
    return true;
  } catch {
    return false;
  }
}

function invalidProcessorStateRecord(path: string, cause?: unknown): Error {
  return new Error(`Invalid processor state record at ${path}`, { cause });
}

function matchesStateIdentity(
  stored: CompatibleStateRecord | null,
  namespace: string,
  key: string,
): stored is CompatibleStateRecord {
  return stored?.namespace === namespace && stored.key === key;
}

function compatibleRecord<Value>(
  namespace: string,
  state: StoredProcessorState<Value>,
): CompatibleStateRecord {
  return { namespace, key: state.key, lastGlobalPosition: 0, value: state.value };
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

interface ProcessorStatePaths {
  readonly namespace: string;
  readonly current: string;
  readonly isolated: string;
  readonly legacy: string;
}
