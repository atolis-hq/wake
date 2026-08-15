import { AsyncLocalStorage } from 'node:async_hooks';
import type { EventJournal } from '../kernel/index.js';
import type { OperationCoordinator } from '../orchestration/index.js';
import { acquireFileLock } from '../persistence/index.js';

export interface TriggerRegistry {
  register(triggers: readonly string[]): void;
  freeze(): void;
  includes(eventType: string): boolean;
}

export function createTriggerRegistry(): TriggerRegistry {
  const triggers = new Set<string>();
  let frozen = false;
  return {
    register(values) {
      if (frozen) throw new Error('Resource transition trigger registry is frozen');
      values.forEach((value) => triggers.add(value));
    },
    freeze() {
      frozen = true;
    },
    includes(eventType) {
      return triggers.has(eventType);
    },
  };
}

const defaultLockTimeoutMs = 30_000;

export class ResourceTransitionLockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for resource-transition ordering lock: ${path}`);
    this.name = 'ResourceTransitionLockTimeoutError';
  }
}

export function createResourceTransitionOrdering(
  lockPath?: string,
  lockTimeoutMs = defaultLockTimeoutMs,
): OperationCoordinator {
  const active = new AsyncLocalStorage<boolean>();
  let queue: Promise<unknown> = Promise.resolve();
  const coordinate: OperationCoordinator = <Result>(operation: () => Promise<Result>) => {
    if (active.getStore() === true) return operation();
    const result = queue.then(async () => {
      const lock =
        lockPath === undefined ? undefined : await waitForFileLock(lockPath, lockTimeoutMs);
      try {
        return await active.run(true, operation);
      } finally {
        await lock?.release();
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  return coordinate;
}

async function waitForFileLock(lockPath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await acquireFileLock(lockPath, {
      staleAfterMs: 60_000,
      staleRequiresDeadProcess: true,
    });
    if (lock.acquired) return lock;
    if (Date.now() >= deadline) throw new ResourceTransitionLockTimeoutError(lockPath, timeoutMs);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

export function createTriggerAwareEventJournal(
  journal: EventJournal,
  registry: TriggerRegistry,
  coordinate: OperationCoordinator,
): EventJournal {
  return {
    append(stream, expectedSequence, events) {
      const append = () => journal.append(stream, expectedSequence, events);
      return events.some(({ eventType }) => registry.includes(eventType))
        ? coordinate(append)
        : append();
    },
    readStream: (stream) => journal.readStream(stream),
    readAll: (afterGlobalPosition, limit) => journal.readAll(afterGlobalPosition, limit),
    ...(journal.readLatest === undefined
      ? {}
      : {
          readLatest: (beforeGlobalPosition?: number, limit?: number) =>
            journal.readLatest!(beforeGlobalPosition, limit),
        }),
  };
}
