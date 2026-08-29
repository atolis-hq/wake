import type { CheckpointStore, EventEnvelope, EventJournal } from '../../kernel/index.js';
import type { SubscriptionRunSerialiser } from './subscription-run-serialiser.js';

const defaultBatchSize = 100;
const maximumBatchSize = 10_000;
const defaultFallbackMs = 30_000;
const maximumTimerDelayMs = 2_147_483_647;

export interface DurableSubscription {
  /** Stable checkpoint and serialisation identity. Handlers must be idempotent. */
  readonly consumer: string;
  readonly handle: (events: readonly EventEnvelope[]) => Promise<void>;
  readonly batchSize?: number;
}

export interface DurableSubscriptionPass {
  readonly checkpoint: number;
  readonly eventCount: number;
}

export type SubscriptionHealthStatus = 'starting' | 'healthy' | 'degraded' | 'stopped';

export interface SubscriptionHealth {
  readonly consumer: string;
  readonly status: SubscriptionHealthStatus;
  readonly checkpoint: number;
  readonly consecutiveFailures: number;
  readonly lastError?: unknown;
}

export interface DurableSubscriptionHostOptions {
  readonly fallbackMs?: number;
  readonly retryBackoff?: (consecutiveFailures: number, signal: AbortSignal) => Promise<void>;
}

export interface DurableSubscriptionHostRun {
  abort(): void;
  readonly done: Promise<void>;
}

export class DurableSubscriptionHost {
  private readonly snapshots = new Map<string, SubscriptionHealth>();
  private readonly fallbackMs: number;
  private readonly retryBackoff: (
    consecutiveFailures: number,
    signal: AbortSignal,
  ) => Promise<void>;

  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: CheckpointStore,
    private readonly serialiseRun: SubscriptionRunSerialiser,
    options: DurableSubscriptionHostOptions = {},
  ) {
    this.fallbackMs = options.fallbackMs ?? defaultFallbackMs;
    this.retryBackoff = options.retryBackoff ?? defaultRetryBackoff;
    assertPositiveSafeInteger(this.fallbackMs, 'Subscription fallback', maximumTimerDelayMs);
    if (typeof this.retryBackoff !== 'function')
      throw new Error('Subscription retry backoff must be a function');
  }

  start(
    subscriptions: readonly DurableSubscription[],
    parentSignal?: AbortSignal,
  ): DurableSubscriptionHostRun {
    assertDistinctConsumers(subscriptions);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    const done = Promise.all(
      subscriptions.map((subscription) => this.runSubscription(subscription, controller.signal)),
    )
      .then(() => undefined)
      .finally(() => parentSignal?.removeEventListener('abort', abort));
    return { abort, done };
  }

  async runOnce(
    subscription: DurableSubscription,
    signal?: AbortSignal,
  ): Promise<DurableSubscriptionPass> {
    assertSubscription(subscription);
    return this.serialiseRun(subscription.consumer, signal ?? new AbortController().signal, () =>
      this.runSubscriptionPass(subscription),
    );
  }

  async runThrough(
    subscription: DurableSubscription,
    targetGlobalPosition: number,
    signal?: AbortSignal,
  ): Promise<DurableSubscriptionPass> {
    assertSubscription(subscription);
    assertNonNegativeSafeInteger(targetGlobalPosition, 'Subscription target global position');
    return this.serialiseRun(subscription.consumer, signal ?? new AbortController().signal, () =>
      this.runSubscriptionThrough(subscription, targetGlobalPosition),
    );
  }

  health(consumer: string): SubscriptionHealth | undefined {
    return this.snapshots.get(consumer);
  }

  private async runSubscription(
    subscription: DurableSubscription,
    signal: AbortSignal,
  ): Promise<void> {
    let checkpoint = 0;
    let consecutiveFailures = 0;
    this.updateHealth(subscription.consumer, 'starting', checkpoint, consecutiveFailures);
    try {
      while (!signal.aborted) {
        try {
          const pass = await this.runOnce(subscription, signal);
          if (signal.aborted) return;
          checkpoint = pass.checkpoint;
          consecutiveFailures = 0;
          this.updateHealth(subscription.consumer, 'healthy', checkpoint, consecutiveFailures);
          if (pass.eventCount === 0)
            await this.journal.waitForEventsAfter(checkpoint, signal, this.fallbackMs);
        } catch (error) {
          if (signal.aborted) return;
          consecutiveFailures += 1;
          this.updateHealth(
            subscription.consumer,
            'degraded',
            checkpoint,
            consecutiveFailures,
            error,
          );
          await this.retryBackoff(consecutiveFailures, signal);
        }
      }
    } finally {
      this.updateHealth(subscription.consumer, 'stopped', checkpoint, consecutiveFailures);
    }
  }

  private async runSubscriptionPass(
    subscription: DurableSubscription,
  ): Promise<DurableSubscriptionPass> {
    const checkpoint = await this.checkpoints.load(subscription.consumer);
    const events = await this.journal.readAll(
      checkpoint,
      subscription.batchSize ?? defaultBatchSize,
    );
    if (events.length === 0) return { checkpoint, eventCount: 0 };
    await subscription.handle(events);
    const nextCheckpoint = events.at(-1)!.globalPosition;
    await this.checkpoints.save(subscription.consumer, nextCheckpoint);
    return { checkpoint: nextCheckpoint, eventCount: events.length };
  }

  private async runSubscriptionThrough(
    subscription: DurableSubscription,
    targetGlobalPosition: number,
  ): Promise<DurableSubscriptionPass> {
    let checkpoint = await this.checkpoints.load(subscription.consumer);
    let eventCount = 0;
    while (checkpoint < targetGlobalPosition) {
      const events = (
        await this.journal.readAll(checkpoint, subscription.batchSize ?? defaultBatchSize)
      ).filter((event) => event.globalPosition <= targetGlobalPosition);
      if (events.length === 0) return { checkpoint, eventCount };
      await subscription.handle(events);
      checkpoint = events.at(-1)!.globalPosition;
      await this.checkpoints.save(subscription.consumer, checkpoint);
      eventCount += events.length;
    }
    return { checkpoint, eventCount };
  }

  private updateHealth(
    consumer: string,
    status: SubscriptionHealthStatus,
    checkpoint: number,
    consecutiveFailures: number,
    lastError?: unknown,
  ): void {
    this.snapshots.set(consumer, {
      consumer,
      status,
      checkpoint,
      consecutiveFailures,
      ...(lastError === undefined ? {} : { lastError }),
    });
  }
}

function assertDistinctConsumers(subscriptions: readonly DurableSubscription[]): void {
  const consumers = new Set<string>();
  for (const subscription of subscriptions) {
    assertSubscription(subscription);
    if (consumers.has(subscription.consumer))
      throw new Error(`Subscription consumer is already registered: ${subscription.consumer}`);
    consumers.add(subscription.consumer);
  }
}

function assertSubscription(subscription: DurableSubscription): void {
  if (typeof subscription.consumer !== 'string' || subscription.consumer.length === 0)
    throw new Error('Subscription consumer must not be empty');
  if (typeof subscription.handle !== 'function')
    throw new Error('Subscription handler must be a function');
  if (subscription.batchSize !== undefined)
    assertPositiveSafeInteger(subscription.batchSize, 'Subscription batch size', maximumBatchSize);
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
