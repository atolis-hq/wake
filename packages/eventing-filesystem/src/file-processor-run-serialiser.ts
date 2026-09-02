import type { ProcessorRunSerialiser } from '@atolis-hq/eventing';
import { join } from 'node:path';
import { acquireFileLock } from './file-lock.js';
import { assertWellFormedUtf16 } from './storage-name.js';

const firstProcessorRetryDelayMs = 10;
const maximumProcessorRetryDelayMs = 250;

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
    let contentions = 0;
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
      contentions += 1;
      await waitForRetry(signal, processorRunRetryDelayMs(contentions));
    }
  };
}

export function processorRunRetryDelayMs(contentions: number): number {
  return Math.min(
    maximumProcessorRetryDelayMs,
    firstProcessorRetryDelayMs * 2 ** Math.max(0, contentions - 1),
  );
}

export function encodeProcessorConsumer(consumer: string): string {
  assertWellFormedUtf16(consumer, 'Processor consumer');
  return Buffer.from(consumer, 'utf8').toString('base64url');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProcessorRunAbortedError();
}

export function waitForRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProcessorRunAbortedError());
      return;
    }
    const timer = setTimeout(completed, milliseconds);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();

    function completed() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve();
    }

    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(new ProcessorRunAbortedError());
    }
  });
}

export class ProcessorRunAbortedError extends Error {
  constructor() {
    super('Processor run aborted');
  }
}
