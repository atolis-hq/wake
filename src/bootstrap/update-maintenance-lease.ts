import { acquireFileLock } from '@atolis-hq/eventing-filesystem';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineClosedVocabulary, type ValueOf } from '../kernel/index.js';

export const UpdateMaintenancePhase = defineClosedVocabulary({
  Quiescing: 'quiescing',
  Updating: 'updating',
  RollingBack: 'rolling-back',
  Failed: 'failed',
} as const);

export type UpdateMaintenancePhase = ValueOf<typeof UpdateMaintenancePhase>;

export interface UpdateMaintenanceState {
  readonly attemptId: string;
  readonly tag: string;
  readonly phase: UpdateMaintenancePhase;
  readonly startedAt: string;
  readonly failure?: string;
}

export interface UpdateMaintenanceLease {
  read(): Promise<UpdateMaintenanceState | null>;
  acquire(tag: string, retryFailed?: boolean): Promise<UpdateMaintenanceState>;
  runExclusive<Value>(
    tag: string,
    retryFailed: boolean,
    operation: (state: UpdateMaintenanceState) => Promise<Value>,
  ): Promise<Value>;
  transition(
    phase: Exclude<UpdateMaintenancePhase, typeof UpdateMaintenancePhase.Failed>,
    attemptId?: string,
  ): Promise<UpdateMaintenanceState>;
  fail(error: unknown, attemptId?: string): Promise<UpdateMaintenanceState>;
  clear(attemptId?: string): Promise<void>;
}

export function createUpdateMaintenanceLease(
  wakeRoot: string,
  now: () => string = () => new Date().toISOString(),
  createAttemptId: () => string = randomUUID,
  isProcessAlive?: (pid: number) => boolean,
): UpdateMaintenanceLease {
  const path = join(wakeRoot, '.wake', 'update-maintenance.json');
  const acquire = async (tag: string, retryFailed = false) =>
    withLeaseLock(path, async () => {
      const existing = await readState(path);
      if (
        existing !== null &&
        !(existing.phase === UpdateMaintenancePhase.Failed && (existing.tag !== tag || retryFailed))
      )
        return existing;
      const initial: UpdateMaintenanceState = {
        attemptId: createAttemptId(),
        tag,
        phase: UpdateMaintenancePhase.Quiescing,
        startedAt: now(),
      };
      await writeState(path, initial);
      return initial;
    });
  return {
    async read() {
      return readState(path);
    },
    acquire,
    async runExclusive(tag, retryFailed, operation) {
      return withAttemptLock(path, isProcessAlive, async () =>
        operation(await acquire(tag, retryFailed)),
      );
    },
    async transition(phase, attemptId) {
      return withLeaseLock(path, async () => {
        const current = await requireState(path);
        requireOwnership(current, attemptId);
        if (!canTransition(current.phase, phase)) {
          throw new Error(`Invalid maintenance lease transition from ${current.phase} to ${phase}`);
        }
        const next = { ...current, phase };
        await writeState(path, next);
        return next;
      });
    },
    async fail(error, attemptId) {
      return withLeaseLock(path, async () => {
        const current = await requireState(path);
        requireOwnership(current, attemptId);
        if (current.phase === UpdateMaintenancePhase.Failed) return current;
        const next: UpdateMaintenanceState = {
          ...current,
          phase: UpdateMaintenancePhase.Failed,
          failure: error instanceof Error ? error.message : String(error),
        };
        await writeState(path, next);
        return next;
      });
    },
    async clear(attemptId) {
      await withLeaseLock(path, async () => {
        const current = await readState(path);
        if (current === null) {
          if (attemptId !== undefined) throw new Error('No maintenance lease is active');
          return;
        }
        requireOwnership(current, attemptId);
        await rm(path, { force: true });
      });
    },
  };
}

function requireOwnership(state: UpdateMaintenanceState, attemptId: string | undefined): void {
  if (attemptId !== undefined && state.attemptId !== attemptId)
    throw new Error(`Maintenance attempt ${attemptId} no longer owns the lease`);
}

function canTransition(
  from: UpdateMaintenancePhase,
  to: Exclude<UpdateMaintenancePhase, typeof UpdateMaintenancePhase.Failed>,
): boolean {
  return (
    (from === UpdateMaintenancePhase.Quiescing && to === UpdateMaintenancePhase.Updating) ||
    (from === UpdateMaintenancePhase.Updating && to === UpdateMaintenancePhase.RollingBack)
  );
}

async function requireState(path: string): Promise<UpdateMaintenanceState> {
  const state = await readState(path);
  if (state === null) throw new Error('No maintenance lease is active');
  return state;
}

async function readState(path: string): Promise<UpdateMaintenanceState | null> {
  try {
    return parseState(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseState(value: unknown): UpdateMaintenanceState {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Record<string, unknown>).attemptId !== 'string' ||
    typeof (value as Record<string, unknown>).tag !== 'string' ||
    !isPhase((value as Record<string, unknown>).phase) ||
    typeof (value as Record<string, unknown>).startedAt !== 'string' ||
    ('failure' in value && typeof (value as Record<string, unknown>).failure !== 'string')
  ) {
    throw new Error('Invalid maintenance lease state');
  }
  return value as UpdateMaintenanceState;
}

function isPhase(value: unknown): value is UpdateMaintenancePhase {
  return (
    value === UpdateMaintenancePhase.Quiescing ||
    value === UpdateMaintenancePhase.Updating ||
    value === UpdateMaintenancePhase.RollingBack ||
    value === UpdateMaintenancePhase.Failed
  );
}

async function writeState(path: string, state: UpdateMaintenanceState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(temporary, path);
}

async function withLeaseLock<Value>(path: string, operation: () => Promise<Value>): Promise<Value> {
  const lockPath = `${path}.lock`;
  while (true) {
    let lock;
    try {
      lock = await acquireFileLock(lockPath, { staleAfterMs: 60_000 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      continue;
    }
    if (lock.acquired) {
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function withAttemptLock<Value>(
  path: string,
  isProcessAlive: ((pid: number) => boolean) | undefined,
  operation: () => Promise<Value>,
): Promise<Value> {
  const lockPath = `${path}.attempt.lock`;
  while (true) {
    let lock;
    try {
      lock = await acquireFileLock(lockPath, {
        staleAfterMs: 60_000,
        staleRequiresDeadProcess: true,
        ...(isProcessAlive === undefined ? {} : { isProcessAlive }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      continue;
    }
    if (lock.acquired) {
      try {
        return await operation();
      } finally {
        await lock.release();
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
