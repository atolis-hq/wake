import type { CheckpointStore, Clock, EventJournal } from '../../kernel/index.js';
import { SystemClock } from '../../kernel/index.js';
import { type EventProcessor } from '../contracts/event-processor.js';
import type { ProcessorRunSerialiser } from '../contracts/processor-run-serialiser.js';
import {
  EventProcessorHealthStatus,
  ProcessorHealthRegistry,
  type EventProcessorHealth,
} from './processor-health.js';
import {
  assertDistinctProcessorConsumers,
  assertNonNegativeSafeInteger,
  assertPositiveSafeInteger,
  assertProcessor,
} from './processor-validation.js';

const defaultBatchSize = 100;
const defaultFallbackMs = 30_000;
const maximumTimerDelayMs = 2_147_483_647;

export interface EventProcessorHostOptions {
  readonly fallbackMs?: number;
  readonly retryBackoff?: (consecutiveFailures: number, signal: AbortSignal) => Promise<void>;
  readonly clock?: Clock;
}

export interface EventProcessorHostRun {
  abort(): void;
  readonly done: Promise<void>;
}

export interface EventProcessorPass {
  readonly checkpoint: number;
  readonly eventCount: number;
  readonly handledCount: number;
}

export class EventProcessorHost {
  private readonly fallbackMs: number;
  private readonly retryBackoff: (
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<void>;

  private readonly clock: Clock;

  private readonly healthRegistry: ProcessorHealthRegistry;

  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    private readonly serialiseRun: ProcessorRunSerialiser,
    options: EventProcessorHostOptions = {},
  ) {
    this.fallbackMs = options.fallbackMs ?? defaultFallbackMs;
    this.retryBackoff = options.retryBackoff ?? defaultRetryBackoff;
    this.clock = options.clock ?? new SystemClock();
    this.healthRegistry = new ProcessorHealthRegistry(journal, this.clock);
    assertPositiveSafeInteger(this.fallbackMs, 'Processor fallback', maximumTimerDelayMs);
    if (typeof this.retryBackoff !== 'function')
      throw new Error('Processor retry backoff must be a function');
  }

  start(processors: readonly EventProcessor[], parentSignal?: AbortSignal): EventProcessorHostRun {
    assertDistinctProcessorConsumers(processors);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const done = Promise.all(
      processors.map((processor) => this.runProcessor(processor, controller.signal)),
    )
      .then(() => undefined)
      .finally(() => parentSignal?.removeEventListener('abort', abort));
    return { abort, done };
  }

  async runOnce(processor: EventProcessor, signal?: AbortSignal): Promise<EventProcessorPass> {
    assertProcessor(processor);
    const runSignal = signal ?? new AbortController().signal;
    return this.serialiseRun(processor.consumer, runSignal, () =>
      this.runProcessorPass(processor, runSignal),
    );
  }

  async runThrough(
    processor: EventProcessor,
    targetGlobalPosition: number,
    signal?: AbortSignal,
  ): Promise<EventProcessorPass> {
    assertProcessor(processor);
    assertNonNegativeSafeInteger(targetGlobalPosition, 'Processor target global position');
    const runSignal = signal ?? new AbortController().signal;
    return this.serialiseRun(processor.consumer, runSignal, () =>
      this.runProcessorThrough(processor, targetGlobalPosition, runSignal),
    );
  }

  health(consumer: string): EventProcessorHealth | undefined {
    return this.healthRegistry.get(consumer);
  }

  private async runProcessor(processor: EventProcessor, signal: AbortSignal): Promise<void> {
    let checkpoint = 0;
    let consecutiveFailures = 0;
    try {
      while (!signal.aborted) {
        try {
          const pass = await this.serialiseRun(processor.consumer, signal, async () => {
            checkpoint = await this.checkpoints.load(processor.consumer);
            await this.healthRegistry.update(
              processor,
              this.healthRegistry.get(processor.consumer) === undefined
                ? EventProcessorHealthStatus.Starting
                : EventProcessorHealthStatus.CatchingUp,
              checkpoint,
              consecutiveFailures,
              { lastAttemptAt: this.healthRegistry.now() },
            );
            return this.runProcessorPass(processor, signal);
          });
          if (signal.aborted) return;
          checkpoint = pass.checkpoint;
          consecutiveFailures = 0;
          const head = await this.journal.latestGlobalPosition();
          const health = await this.healthRegistry.update(
            processor,
            checkpoint >= head
              ? EventProcessorHealthStatus.Healthy
              : EventProcessorHealthStatus.CatchingUp,
            checkpoint,
            consecutiveFailures,
            { lastSuccessAt: this.healthRegistry.now() },
            head,
          );
          if (checkpoint >= health.head)
            await this.journal.waitForEventsAfter(checkpoint, signal, this.fallbackMs);
        } catch (error) {
          if (signal.aborted) return;
          consecutiveFailures += 1;
          try {
            checkpoint = await this.checkpoints.load(processor.consumer);
          } catch {
            // The next supervised attempt re-reads the durable checkpoint.
          }
          await this.healthRegistry.degrade(processor, checkpoint, consecutiveFailures, error);
          await this.retryBackoff(consecutiveFailures, signal);
        }
      }
    } finally {
      try {
        await this.healthRegistry.update(
          processor,
          EventProcessorHealthStatus.Stopped,
          checkpoint,
          consecutiveFailures,
        );
      } catch {
        // Volatile health must not make shutdown fail.
      }
    }
  }

  private async runProcessorPass(
    processor: EventProcessor,
    signal: AbortSignal,
    targetGlobalPosition?: number,
  ): Promise<EventProcessorPass> {
    const checkpoint = await this.checkpoints.load(processor.consumer);
    const events = await this.journal.readAll(checkpoint, processor.batchSize ?? defaultBatchSize);
    const bounded =
      targetGlobalPosition === undefined
        ? events
        : events.filter((event) => event.globalPosition <= targetGlobalPosition);
    if (bounded.length === 0) return { checkpoint, eventCount: 0, handledCount: 0 };
    throwIfAborted(signal);
    if (processor.mode === 'batch') {
      await processor.handle(bounded, signal);
      const nextCheckpoint = bounded.at(-1)!.globalPosition;
      await this.checkpoints.save(processor.consumer, nextCheckpoint);
      return {
        checkpoint: nextCheckpoint,
        eventCount: bounded.length,
        handledCount: bounded.length,
      };
    }
    let handledCount = 0;
    for (const event of bounded) {
      throwIfAborted(signal);
      const message = processor.select(event);
      if (message === null) continue;
      handledCount += 1;
      await processor.handle(message, event, signal);
    }
    const nextCheckpoint = bounded.at(-1)!.globalPosition;
    await this.checkpoints.save(processor.consumer, nextCheckpoint);
    return { checkpoint: nextCheckpoint, eventCount: bounded.length, handledCount };
  }

  private async runProcessorThrough(
    processor: EventProcessor,
    targetGlobalPosition: number,
    signal: AbortSignal,
  ): Promise<EventProcessorPass> {
    let checkpoint = await this.checkpoints.load(processor.consumer);
    let eventCount = 0;
    let handledCount = 0;
    while (checkpoint < targetGlobalPosition) {
      const pass = await this.runProcessorPass(processor, signal, targetGlobalPosition);
      if (pass.eventCount === 0) return { checkpoint, eventCount, handledCount };
      checkpoint = pass.checkpoint;
      eventCount += pass.eventCount;
      handledCount += pass.handledCount;
    }
    return { checkpoint, eventCount, handledCount };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new EventProcessorRunAbortedError();
}

function defaultRetryBackoff(consecutiveFailures: number, signal: AbortSignal): Promise<void> {
  return abortableDelay(Math.min(1_000, 25 * 2 ** Math.min(consecutiveFailures - 1, 5)), signal);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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

export class EventProcessorRunAbortedError extends Error {
  constructor() {
    super('Event processor run aborted');
  }
}
