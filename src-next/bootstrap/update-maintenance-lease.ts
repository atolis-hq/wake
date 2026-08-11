import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireFileLock } from '../persistence/index.js';

export type UpdateMaintenancePhase = 'quiescing' | 'updating' | 'rolling-back' | 'failed';

export interface UpdateMaintenanceState {
  readonly attemptId: string;
  readonly tag: string;
  readonly phase: UpdateMaintenancePhase;
  readonly startedAt: string;
  readonly failure?: string;
}

export interface UpdateMaintenanceLease {
  read(): Promise<UpdateMaintenanceState | null>;
  acquire(tag: string): Promise<UpdateMaintenanceState>;
  transition(phase: Exclude<UpdateMaintenancePhase, 'failed'>): Promise<UpdateMaintenanceState>;
  fail(error: unknown): Promise<UpdateMaintenanceState>;
  clear(): Promise<void>;
}

export function createUpdateMaintenanceLease(
  wakeRoot: string,
  now: () => string = () => new Date().toISOString(),
  createAttemptId: () => string = randomUUID,
): UpdateMaintenanceLease {
  const path = join(wakeRoot, '.wake', 'update-maintenance.json');
  return {
    async read() {
      return readState(path);
    },
    async acquire(tag) {
      return withLeaseLock(path, async () => {
        const existing = await readState(path);
        if (existing !== null) return existing;
        const initial: UpdateMaintenanceState = {
          attemptId: createAttemptId(),
          tag,
          phase: 'quiescing',
          startedAt: now(),
        };
        await writeState(path, initial);
        return initial;
      });
    },
    async transition(phase) {
      return withLeaseLock(path, async () => {
        const current = await requireState(path);
        if (!canTransition(current.phase, phase)) {
          throw new Error(`Invalid maintenance lease transition from ${current.phase} to ${phase}`);
        }
        const next = { ...current, phase };
        await writeState(path, next);
        return next;
      });
    },
    async fail(error) {
      return withLeaseLock(path, async () => {
        const current = await requireState(path);
        if (current.phase === 'failed') return current;
        const next: UpdateMaintenanceState = {
          ...current,
          phase: 'failed',
          failure: error instanceof Error ? error.message : String(error),
        };
        await writeState(path, next);
        return next;
      });
    },
    async clear() {
      await withLeaseLock(path, () => rm(path, { force: true }));
    },
  };
}

function canTransition(
  from: UpdateMaintenancePhase,
  to: Exclude<UpdateMaintenancePhase, 'failed'>,
): boolean {
  return (
    (from === 'quiescing' && to === 'updating') || (from === 'updating' && to === 'rolling-back')
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
    value === 'quiescing' || value === 'updating' || value === 'rolling-back' || value === 'failed'
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
    const lock = await acquireFileLock(lockPath, { staleAfterMs: 60_000 });
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
