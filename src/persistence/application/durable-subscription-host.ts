import type { CheckpointStore, EventEnvelope, EventJournal } from '../../kernel/index.js';
import {
  createInMemorySubscriptionRunSerialiser,
  type SubscriptionRunSerialiser,
} from './subscription-run-serialiser.js';

const defaultBatchSize = 100;
const defaultFallbackMs = 30_000;

export interface DurableSubscription {
  /** Stable checkpoint and serialisation identity. Handlers must be idempotent. */
  readonly consumer: string;
  readonly handle: (events: readonly EventEnvelope[]) => Promise<void>;
  readonly batchSize?: number;
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
    private readonly serialiseRun: SubscriptionRunSerialiser = createInMemorySubscriptionRunSerialiser(),
    options: DurableSubscriptionHostOptions = {},
  ) {
    this.fallbackMs = options.fallbackMs ?? defaultFallbackMs;
    this.retryBackoff = options.retryBackoff ?? defaultRetryBackoff;
  }

  start(
    subscriptions: readonly DurableSubscription[],
    parentSignal?: AbortSignal,
  ): DurableSubscriptionHostRun {
    assertDistinctConsumers(subscriptions);
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    const done = Promise.all(
      subscriptions.map((subscription) => this.runSubscription(subscription, controller.signal)),
    )
      .then(() => undefined)
      .finally(() => parentSignal?.removeEventListener('abort', abort));
    return { abort, done };
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
          const pass = await this.serialiseRun(subscription.consumer, signal, async () => {
            const loadedCheckpoint = await this.checkpoints.load(subscription.consumer);
            const events = await this.journal.readAll(
              loadedCheckpoint,
              subscription.batchSize ?? defaultBatchSize,
            );
            if (events.length === 0) return { checkpoint: loadedCheckpoint, handled: false };
            await subscription.handle(events);
            const nextCheckpoint = events.at(-1)!.globalPosition;
            await this.checkpoints.save(subscription.consumer, nextCheckpoint);
            return { checkpoint: nextCheckpoint, handled: true };
          });
          if (signal.aborted) return;
          checkpoint = pass.checkpoint;
          consecutiveFailures = 0;
          this.updateHealth(subscription.consumer, 'healthy', checkpoint, consecutiveFailures);
          if (!pass.handled)
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
    if (subscription.consumer.length === 0)
      throw new Error('Subscription consumer must not be empty');
    if (consumers.has(subscription.consumer))
      throw new Error(`Subscription consumer is already registered: ${subscription.consumer}`);

    consumers.add(subscription.consumer);
  }
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
