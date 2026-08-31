import type { ProcessorRunSerialiser } from '@atolis-hq/eventing';
import { join } from 'node:path';
import { acquireFileLock } from '../filesystem/file-lock.js';
import { assertWellFormedUtf16 } from '../filesystem/storage-name.js';

export function createInMemoryProcessorRunSerialiser(): ProcessorRunSerialiser {
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

export function createFileProcessorRunSerialiser(dataRoot: string): ProcessorRunSerialiser {
  let acquireTail: Promise<void> = Promise.resolve();
  const acquire = async (path: string) => {
    const prior = acquireTail;
    let release!: () => void;
    acquireTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await acquireFileLock(path, {
        staleAfterMs: 60_000,
        staleRequiresDeadProcess: true,
      });
    } finally {
      release();
    }
  };
  return async <Value>(consumer: string, signal: AbortSignal, operation: () => Promise<Value>) => {
    const path = join(dataRoot, 'locks', `subscription-${encodeProcessorConsumer(consumer)}.lock`);
    while (true) {
      throwIfAborted(signal);
      const lock = await acquire(path);
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

export function encodeProcessorConsumer(consumer: string): string {
  assertWellFormedUtf16(consumer, 'Processor consumer');
  return Buffer.from(consumer, 'utf8').toString('base64url');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProcessorRunAbortedError();
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

export class ProcessorRunAbortedError extends Error {
  constructor() {
    super('Processor run aborted');
  }
}
