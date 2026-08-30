import type { CheckpointStore, Clock, EventJournal } from '../../kernel/index.js';
import { SystemClock } from '../../kernel/index.js';
import {
  EventProcessorCategory,
  EventProcessorReplayPolicy,
  type EventProcessorDefinition,
} from '../contracts/event-processor.js';
import type { ProcessorRunSerialiser } from '../contracts/processor-run-serialiser.js';

const defaultBatchSize = 100;
const maximumBatchSize = 10_000;
const defaultFallbackMs = 30_000;
const maximumTimerDelayMs = 2_147_483_647;
const maximumErrorLength = 1_000;

export const EventProcessorHealthStatus = {
  Starting: `start${'ing'}`,
  CatchingUp: `catching-${'up'}`,
  Healthy: `health${'y'}`,
  Degraded: `degrad${'ed'}`,
  Stopped: `stopp${'ed'}`,
} as const;

export type EventProcessorHealthStatus =
  (typeof EventProcessorHealthStatus)[keyof typeof EventProcessorHealthStatus];

export interface EventProcessorHealth {
  readonly consumer: string;
  readonly name: string;
  readonly owner: string;
  readonly category: (typeof EventProcessorCategory)[keyof typeof EventProcessorCategory];
  readonly status: EventProcessorHealthStatus;
  readonly checkpoint: number;
  readonly journalHead: number;
  readonly lag: number;
  readonly consecutiveFailures: number;
  readonly lastError?: { readonly name: string; readonly message: string };
  readonly lastAttemptAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastFailureAt?: string;
}

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
  private readonly snapshots = new Map<string, EventProcessorHealth>();
  private readonly fallbackMs: number;
  private readonly retryBackoff: (
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly clock: Clock;

  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    private readonly serialiseRun: ProcessorRunSerialiser,
    options: EventProcessorHostOptions = {},
  ) {
    this.fallbackMs = options.fallbackMs ?? defaultFallbackMs;
    this.retryBackoff = options.retryBackoff ?? defaultRetryBackoff;
    this.clock = options.clock ?? new SystemClock();
    assertPositiveSafeInteger(this.fallbackMs, 'Processor fallback', maximumTimerDelayMs);
    if (typeof this.retryBackoff !== 'function')
      throw new Error('Processor retry backoff must be a function');
  }

  start(
    processors: readonly EventProcessorDefinition<unknown>[],
    parentSignal?: AbortSignal,
  ): EventProcessorHostRun {
    assertDistinctConsumers(processors);
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

  async runOnce<Message>(
    processor: EventProcessorDefinition<Message>,
    signal?: AbortSignal,
  ): Promise<EventProcessorPass> {
    assertProcessor(processor);
    const runSignal = signal ?? new AbortController().signal;
    return this.serialiseRun(processor.consumer, runSignal, () =>
      this.runProcessorPass(processor, runSignal),
    );
  }

  async runThrough<Message>(
    processor: EventProcessorDefinition<Message>,
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
    return this.snapshots.get(consumer);
  }

  private async runProcessor(
    processor: EventProcessorDefinition<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    let checkpoint = await this.checkpoints.load(processor.consumer);
    let consecutiveFailures = 0;
    await this.updateHealth(
      processor,
      EventProcessorHealthStatus.Starting,
      checkpoint,
      consecutiveFailures,
    );
    try {
      while (!signal.aborted) {
        try {
          await this.updateHealth(
            processor,
            EventProcessorHealthStatus.CatchingUp,
            checkpoint,
            consecutiveFailures,
            { lastAttemptAt: this.now() },
          );
          const pass = await this.runOnce(processor, signal);
          if (signal.aborted) return;
          checkpoint = pass.checkpoint;
          consecutiveFailures = 0;
          const status =
            pass.eventCount === 0
              ? EventProcessorHealthStatus.Healthy
              : EventProcessorHealthStatus.CatchingUp;
          await this.updateHealth(processor, status, checkpoint, consecutiveFailures, {
            lastSuccessAt: this.now(),
          });
          if (pass.eventCount === 0)
            await this.journal.waitForEventsAfter(checkpoint, signal, this.fallbackMs);
        } catch (error) {
          if (signal.aborted) return;
          consecutiveFailures += 1;
          checkpoint = await this.checkpoints.load(processor.consumer);
          await this.updateHealth(
            processor,
            EventProcessorHealthStatus.Degraded,
            checkpoint,
            consecutiveFailures,
            { lastError: boundedError(error), lastFailureAt: this.now() },
          );
          await this.retryBackoff(consecutiveFailures, signal);
        }
      }
    } finally {
      await this.updateHealth(
        processor,
        EventProcessorHealthStatus.Stopped,
        checkpoint,
        consecutiveFailures,
      );
    }
  }

  private async runProcessorPass<Message>(
    processor: EventProcessorDefinition<Message>,
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

  private async runProcessorThrough<Message>(
    processor: EventProcessorDefinition<Message>,
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

  private async updateHealth(
    processor: EventProcessorDefinition<unknown>,
    status: EventProcessorHealthStatus,
    checkpoint: number,
    consecutiveFailures: number,
    update: Partial<
      Pick<EventProcessorHealth, 'lastError' | 'lastAttemptAt' | 'lastSuccessAt' | 'lastFailureAt'>
    > = {},
  ): Promise<void> {
    const previous = this.snapshots.get(processor.consumer);
    const journalHead = await this.journal.latestGlobalPosition();
    this.snapshots.set(processor.consumer, {
      consumer: processor.consumer,
      name: processor.name,
      owner: processor.owner,
      category: processor.category,
      status,
      checkpoint,
      journalHead,
      lag: Math.max(0, journalHead - checkpoint),
      consecutiveFailures,
      ...(previous?.lastError === undefined ? {} : { lastError: previous.lastError }),
      ...(previous?.lastAttemptAt === undefined ? {} : { lastAttemptAt: previous.lastAttemptAt }),
      ...(previous?.lastSuccessAt === undefined ? {} : { lastSuccessAt: previous.lastSuccessAt }),
      ...(previous?.lastFailureAt === undefined ? {} : { lastFailureAt: previous.lastFailureAt }),
      ...update,
    });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function assertDistinctConsumers(processors: readonly EventProcessorDefinition<unknown>[]): void {
  const consumers = new Set<string>();
  for (const processor of processors) {
    assertProcessor(processor);
    if (consumers.has(processor.consumer))
      throw new Error(`Processor consumer is already registered: ${processor.consumer}`);
    consumers.add(processor.consumer);
  }
}

function assertProcessor(processor: EventProcessorDefinition<unknown>): void {
  if (typeof processor.consumer !== 'string' || processor.consumer.length === 0)
    throw new Error('Processor consumer must not be empty');
  if (typeof processor.name !== 'string' || processor.name.length === 0)
    throw new Error('Processor name must not be empty');
  if (typeof processor.owner !== 'string' || processor.owner.length === 0)
    throw new Error('Processor owner must not be empty');
  if (!Object.values(EventProcessorCategory).includes(processor.category))
    throw new Error('Processor category must be recognized');
  if (!Object.values(EventProcessorReplayPolicy).includes(processor.replayPolicy))
    throw new Error('Processor replay policy must be recognized');
  if (typeof processor.select !== 'function')
    throw new Error('Processor selector must be a function');
  if (typeof processor.handle !== 'function')
    throw new Error('Processor handler must be a function');
  if (processor.batchSize !== undefined)
    assertPositiveSafeInteger(processor.batchSize, 'Processor batch size', maximumBatchSize);
}

function assertPositiveSafeInteger(value: number, label: string, maximum?: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || (maximum !== undefined && value > maximum))
    throw new Error(
      `${label} must be a positive safe integer${maximum === undefined ? '' : ` no greater than ${maximum}`}`,
    );
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
}

function boundedError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error)
    return { name: error.name, message: error.message.slice(0, maximumErrorLength) };
  return { name: 'Error', message: String(error).slice(0, maximumErrorLength) };
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
