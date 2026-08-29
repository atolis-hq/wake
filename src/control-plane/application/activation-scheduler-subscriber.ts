import type { EventEnvelope } from '../../kernel/index.js';
import type { AdvanceOptions, AdvanceResult } from '../contracts/views.js';
import type { ActivationScheduler } from './activation-scheduler.js';

/** Durable subscriber/checkpoint identity; held across event load, handling, and save. */
export const activationSchedulerSubscriptionConsumer =
  'subscriber:control-plane.activation-scheduler';

/** Global scheduler critical-section identity; distinct from the subscription checkpoint lock. */
export const activationSchedulerCriticalSectionConsumer =
  'control-plane.activation-scheduler-critical-section';

const defaultFallbackMs = 30_000;
const maximumTimerDelayMs = 2_147_483_647;

export interface ActivationSchedulerSubscriberOptions {
  readonly fallbackMs?: number;
  /** Test seam for deterministic reconciliation barriers. */
  readonly waitForFallback?: (signal: AbortSignal, milliseconds: number) => Promise<void>;
}

export interface ActivationSchedulerSubscriberRun {
  abort(): void;
  readonly done: Promise<void>;
}

/** Bootstrap adapts Persistence's durable host to this Control Plane port. */
export interface ActivationSchedulerSubscriptionHost {
  start(
    subscriptions: readonly {
      readonly consumer: string;
      readonly handle: (events: readonly EventEnvelope[]) => Promise<void>;
    }[],
    signal?: AbortSignal,
  ): ActivationSchedulerSubscriberRun;
  health(consumer: string): ActivationSchedulerSubscriptionHealth | undefined;
}

export interface ActivationSchedulerSubscriptionHealth {
  readonly consumer: string;
  readonly status: 'starting' | 'healthy' | 'degraded' | 'stopped';
  readonly checkpoint: number;
  readonly consecutiveFailures: number;
  readonly lastError?: unknown;
}

/** Schedules durable activation work independently from slow runner reactors. */
export interface ActivationSchedulerSubscriber {
  start(signal?: AbortSignal): ActivationSchedulerSubscriberRun;
  poke(options?: AdvanceOptions, signal?: AbortSignal): Promise<AdvanceResult>;
  health(): ActivationSchedulerSubscriptionHealth | undefined;
}

export function createActivationSchedulerSubscriber(
  host: ActivationSchedulerSubscriptionHost,
  scheduler: ActivationScheduler,
  options: ActivationSchedulerSubscriberOptions = {},
): ActivationSchedulerSubscriber {
  const fallbackMs = options.fallbackMs ?? defaultFallbackMs;
  const waitForFallback = options.waitForFallback ?? waitUntilAbort;
  let reconciliationFailures = 0;
  let reconciliationError: unknown;
  if (!Number.isSafeInteger(fallbackMs) || fallbackMs <= 0 || fallbackMs > maximumTimerDelayMs)
    throw new Error(
      `Activation scheduler fallback must be a positive safe integer no greater than ${maximumTimerDelayMs}`,
    );

  const poke = async (
    advance: AdvanceOptions = { maxProgress: 1 },
    signal?: AbortSignal,
  ): Promise<AdvanceResult> => {
    try {
      const result = await scheduler.runOnce(advance, signal);
      reconciliationFailures = 0;
      reconciliationError = undefined;
      return result;
    } catch (error) {
      reconciliationFailures += 1;
      reconciliationError = error;
      throw error;
    }
  };
  return {
    start(parentSignal?: AbortSignal) {
      const controller = new AbortController();
      const abort = (_event: Event) => controller.abort();
      if (parentSignal?.aborted) controller.abort();
      else parentSignal?.addEventListener('abort', abort, { once: true });
      const durable = host.start(
        [
          {
            consumer: activationSchedulerSubscriptionConsumer,
            // Every fact can affect eligibility, capacity, expiry recovery, or a
            // workflow's next activation; filtering here would create stale work.
            handle: async () => {
              await poke(undefined, controller.signal);
            },
          },
        ],
        controller.signal,
      );
      const startup = reconcileIgnoringFailure(() => poke(undefined, controller.signal));
      const fallback = reconcileOnFallback(controller.signal, fallbackMs, waitForFallback, () =>
        poke(undefined, controller.signal),
      );
      const done = Promise.all([durable.done, startup, fallback])
        .then(() => undefined)
        .finally(() => parentSignal?.removeEventListener('abort', abort));
      return {
        abort: () => {
          controller.abort();
          durable.abort();
        },
        done,
      };
    },
    poke,
    health: () => {
      const durable = host.health(activationSchedulerSubscriptionConsumer);
      if (reconciliationFailures === 0) return durable;
      return {
        consumer: activationSchedulerSubscriptionConsumer,
        status: 'degraded',
        checkpoint: durable?.checkpoint ?? 0,
        consecutiveFailures: reconciliationFailures,
        lastError: reconciliationError,
      };
    },
  };
}

async function reconcileOnFallback(
  signal: AbortSignal,
  fallbackMs: number,
  waitForFallback: (signal: AbortSignal, milliseconds: number) => Promise<void>,
  poke: () => Promise<AdvanceResult>,
): Promise<void> {
  while (!signal.aborted) {
    await waitForFallback(signal, fallbackMs);
    if (signal.aborted) return;
    await reconcileIgnoringFailure(poke);
  }
}

async function reconcileIgnoringFailure(poke: () => Promise<AdvanceResult>): Promise<void> {
  try {
    await poke();
  } catch {
    // A later durable event or fallback pass retries. Event handling itself is
    // left to the host so its checkpoint only advances after scheduler success.
  }
}

function waitUntilAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();

    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
