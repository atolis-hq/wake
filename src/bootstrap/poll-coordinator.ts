import { join } from 'node:path';

import type { EventJournal } from '@atolis-hq/eventing';
import { acquireFileLock } from '@atolis-hq/eventing-filesystem';

import { PollService, type ProviderInstance } from '../integrations/index.js';

export const PollOutcome = {
  Polled: 'polled',
  LockContended: 'lock-contended',
} as const;

export interface PollCoordinatorOptions {
  readonly journal: EventJournal;
  readonly wakeRoot: string;
  /** Wall-clock bound for one poll run; the lock is released when it elapses. */
  readonly deadlineMs?: number;
  /** How long to wait for another process holding the poll lock before skipping the tick. */
  readonly lockWaitMs?: number;
}

export interface PollRunOptions {
  readonly bypassInterval?: boolean;
}

export interface PollRunResult {
  readonly outcome: (typeof PollOutcome)[keyof typeof PollOutcome];
  readonly appended: number;
}

export const DEFAULT_POLL_DEADLINE_MS = 5 * 60_000;

export const DEFAULT_POLL_LOCK_WAIT_MS = 5_000;

export type PollCoordinator = ReturnType<typeof createPollCoordinator>;

/**
 * Single-flight per adapter inside the process (intake and webhook polls join
 * one another); the file lock only guards against other processes. Every run
 * is bounded so a hung request cannot pin the lock for the life of the process.
 */
export function createPollCoordinator(options: PollCoordinatorOptions) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_POLL_DEADLINE_MS;
  const lockWaitMs = options.lockWaitMs ?? DEFAULT_POLL_LOCK_WAIT_MS;
  const inFlight = new Map<string, Promise<PollRunResult>>();

  const run = async (
    provider: ProviderInstance,
    signal: AbortSignal,
    pollOptions: PollRunOptions,
  ): Promise<PollRunResult> => {
    const lockPath = join(options.wakeRoot, '.wake', 'locks', `poll-${provider.adapter}.lock`);
    const lock = await acquireWithin(lockPath, lockWaitMs);
    if (!lock.acquired) {
      const error = new Error(`Poll lock is held by another process: ${lockPath}`);
      provider.recordPollFailure?.(error);
      console.warn(`Skipping ${provider.adapter} poll: ${error.message}`);
      return { outcome: PollOutcome.LockContended, appended: 0 };
    }
    try {
      const result = await runWithDeadline(
        (boundedSignal) =>
          new PollService(options.journal, provider).pollOnce(boundedSignal, pollOptions),
        signal,
        deadlineMs,
        provider.adapter,
      );
      return { outcome: PollOutcome.Polled, appended: result.appended };
    } catch (error) {
      provider.recordPollFailure?.(error);
      throw error;
    } finally {
      await lock.release();
    }
  };

  return {
    /**
     * Joins the existing run using its original signal; a joining caller cannot
     * cancel it. Changes arriving after its reads wait for the next interval.
     */
    poll(
      provider: ProviderInstance,
      signal: AbortSignal,
      pollOptions: PollRunOptions = {},
    ): Promise<PollRunResult> {
      const existing = inFlight.get(provider.adapter);
      if (existing !== undefined) return existing;
      const started = run(provider, signal, pollOptions).finally(() => {
        inFlight.delete(provider.adapter);
      });
      inFlight.set(provider.adapter, started);
      return started;
    },
  };
}

async function acquireWithin(path: string, waitMs: number) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = await acquireFileLock(path, {
      staleAfterMs: 60_000,
      staleRequiresDeadProcess: true,
    });
    if (lock.acquired || Date.now() >= deadline) return lock;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runWithDeadline<Value>(
  operation: (signal: AbortSignal) => Promise<Value>,
  outer: AbortSignal,
  deadlineMs: number,
  adapter: string,
): Promise<Value> {
  const controller = new AbortController();
  const abort = () => controller.abort(outer.reason);
  if (outer.aborted) abort();
  else outer.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Polling ${adapter} exceeded its ${deadlineMs}ms deadline`);
      // Abort first so cooperative work stops, but reject regardless: release
      // of the lock must not depend on the hung operation honouring the signal.
      controller.abort(error);
      reject(error);
    }, deadlineMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', abort);
  }
}
