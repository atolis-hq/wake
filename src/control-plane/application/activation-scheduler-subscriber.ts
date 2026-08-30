import {
  EventProcessorCategory,
  EventProcessorHealthStatus,
  EventProcessorReplayPolicy,
  createBatchEventProcessor,
  type EventProcessor,
} from '../../eventing/index.js';
import { ControlStreamKind } from '../contracts/streams.js';
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

export const ActivationSchedulerSubscriptionStatus = {
  Starting: EventProcessorHealthStatus.Starting,
  CatchingUp: EventProcessorHealthStatus.CatchingUp,
  Healthy: EventProcessorHealthStatus.Healthy,
  Degraded: EventProcessorHealthStatus.Degraded,
  Stopped: EventProcessorHealthStatus.Stopped,
} as const;

export type ActivationSchedulerSubscriptionHealthStatus =
  (typeof ActivationSchedulerSubscriptionStatus)[keyof typeof ActivationSchedulerSubscriptionStatus];

export interface ActivationSchedulerSubscriberOptions {
  readonly fallbackMs?: number;
  /** Test seam for deterministic reconciliation barriers. */
  readonly waitForFallback?: (signal: AbortSignal, milliseconds: number) => Promise<void>;
}

export interface ActivationSchedulerSubscriberRun {
  abort(): void;
  readonly done: Promise<void>;
}

export interface ActivationSchedulerSubscriptionHealth {
  readonly consumer: string;
  readonly status: ActivationSchedulerSubscriptionHealthStatus;
  readonly checkpoint: number;
  readonly consecutiveFailures: number;
  readonly lastError?: unknown;
}

/** Schedules durable activation work independently from slow runner reactors. */
export interface ActivationSchedulerSubscriber {
  /** The named Eventing processor that schedules once for each delivered batch. */
  readonly processor: EventProcessor;
  start(signal?: AbortSignal): ActivationSchedulerSubscriberRun;
  poke(options?: AdvanceOptions, signal?: AbortSignal): Promise<AdvanceResult>;
  /** Result from the most recent processor-owned scheduler pass, if any. */
  lastResult(): AdvanceResult | undefined;
  health(): ActivationSchedulerSubscriptionHealth | undefined;
}

export function createActivationSchedulerSubscriber(
  scheduler: ActivationScheduler,
  options: ActivationSchedulerSubscriberOptions = {},
): ActivationSchedulerSubscriber {
  const fallbackMs = options.fallbackMs ?? defaultFallbackMs;
  const waitForFallback = options.waitForFallback ?? waitUntilAbort;
  let reconciliationFailures = 0;
  let reconciliationError: unknown;
  let lastResult: AdvanceResult | undefined;
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
      lastResult = result;
      reconciliationFailures = 0;
      reconciliationError = undefined;
      return result;
    } catch (error) {
      reconciliationFailures += 1;
      reconciliationError = error;
      throw error;
    }
  };
  const processor = createBatchEventProcessor({
    consumer: activationSchedulerSubscriptionConsumer,
    name: 'activation-scheduler',
    owner: ControlStreamKind.Global,
    category: EventProcessorCategory.Coordinator,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    handle: async (_events, signal) => {
      await poke(undefined, signal);
    },
  });
  return {
    processor,
    start: (parentSignal) => createSubscriberRun(parentSignal, fallbackMs, waitForFallback, poke),
    poke,
    lastResult: () => lastResult,
    health: () => {
      if (reconciliationFailures === 0) return undefined;
      return {
        consumer: activationSchedulerSubscriptionConsumer,
        status: ActivationSchedulerSubscriptionStatus.Degraded,
        checkpoint: 0,
        consecutiveFailures: reconciliationFailures,
        ...(reconciliationError === undefined ? {} : { lastError: reconciliationError }),
      };
    },
  };
}

function createSubscriberRun(
  parentSignal: AbortSignal | undefined,
  fallbackMs: number,
  waitForFallback: ActivationSchedulerSubscriberOptions['waitForFallback'] extends infer Wait
    ? Exclude<Wait, undefined>
    : never,
  poke: (options?: AdvanceOptions, signal?: AbortSignal) => Promise<AdvanceResult>,
): ActivationSchedulerSubscriberRun {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const startup = reconcileIgnoringFailure(() => poke(undefined, controller.signal));
  const fallback = reconcileOnFallback(controller.signal, fallbackMs, waitForFallback, () =>
    poke(undefined, controller.signal),
  );
  return {
    abort,
    done: Promise.all([startup, fallback])
      .then(() => undefined)
      .finally(() => parentSignal?.removeEventListener('abort', abort)),
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
