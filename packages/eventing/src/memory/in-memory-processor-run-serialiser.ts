import type { ProcessorRunSerialiser } from '../runtime/processor-run-serialiser.js';

export function createInMemoryProcessorRunSerialiser(): ProcessorRunSerialiser {
  const tails = new Map<string, Promise<unknown>>();
  return async <Value>(consumer: string, signal: AbortSignal, operation: () => Promise<Value>) => {
    const prior = tails.get(consumer) ?? Promise.resolve();
    const current = prior
      .catch(() => undefined)
      .then(async () => {
        if (signal.aborted) throw new ProcessorRunAbortedError();
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

export class ProcessorRunAbortedError extends Error {
  constructor() {
    super('Processor run aborted');
  }
}
