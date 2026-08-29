import { join } from 'node:path';
import { acquireFileLock } from '../filesystem/file-lock.js';

export type SubscriptionRunSerialiser = <Value>(
  consumer: string,
  signal: AbortSignal,
  operation: () => Promise<Value>,
) => Promise<Value>;

export function createInMemorySubscriptionRunSerialiser(): SubscriptionRunSerialiser {
  const tails = new Map<string, Promise<unknown>>();
  return async <Value>(consumer: string, signal: AbortSignal, operation: () => Promise<Value>) => {
    const prior = tails.get(consumer) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(async () => {
        throwIfAborted(signal);
        return operation();
      });
    tails.set(consumer, current);
    try {
      return await current;
    } finally {
      if (tails.get(consumer) === current) tails.delete(consumer);
    }
  };
}

export function createFileSubscriptionRunSerialiser(dataRoot: string): SubscriptionRunSerialiser {
  return async <Value>(consumer: string, signal: AbortSignal, operation: () => Promise<Value>) => {
    const path = join(
      dataRoot,
      'locks',
      `subscription-${encodeSubscriptionConsumer(consumer)}.lock`,
    );
    while (true) {
      throwIfAborted(signal);
      const lock = await acquireFileLock(path, {
        staleAfterMs: 60_000,
        staleRequiresDeadProcess: true,
      });
      if (lock.acquired) {
        try {
          throwIfAborted(signal);
          return await operation();
        } finally {
          await lock.release();
        }
      }
      await waitForRetry(signal, 10);
    }
  };
}

export function encodeSubscriptionConsumer(consumer: string): string {
  return Buffer.from(consumer, 'utf8').toString('base64url');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SubscriptionRunAbortedError();
}

function waitForRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export class SubscriptionRunAbortedError extends Error {
  constructor() {
    super('Subscription run aborted');
  }
}
