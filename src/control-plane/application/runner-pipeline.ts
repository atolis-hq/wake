import type { AdvanceOptions, AdvanceResult } from '../contracts/views.js';

export type RunnerPipelineResult = Extract<AdvanceResult, { readonly kind: 'no-work' | 'paused' }>;

export interface RunnerPipelineStages {
  readonly isPaused?: () => Promise<boolean>;
  readonly runSchedules: () => Promise<void>;
  readonly react: () => Promise<void>;
  readonly publishAgentRuns?: () => Promise<void>;
  readonly deliver: (signal: AbortSignal) => Promise<void>;
}

export interface RunnerPipeline {
  /**
   * `beforeDelivery` lets the subscriber-mode one-shot adapter schedule the
   * facts this pipeline has produced before an outbound delivery can block.
   */
  run(
    options: AdvanceOptions,
    signal?: AbortSignal,
    beforeDelivery?: () => Promise<void>,
  ): Promise<RunnerPipelineResult>;
}

/**
 * Runs the internal half of a Wake tick: schedules, reactors, publication,
 * and delivery. None of this touches a rate-limited external poll, so its
 * host runs on a fast, un-backed-off cadence — see IntakePipeline for the
 * half that does need backoff.
 */
export function createRunnerPipeline(stages: RunnerPipelineStages): RunnerPipeline {
  const isPaused = async () => (await stages.isPaused?.()) ?? false;
  const runOnce = async (
    options: AdvanceOptions,
    signal: AbortSignal,
    beforeDelivery: (() => Promise<void>) | undefined,
  ): Promise<RunnerPipelineResult> => {
    if (await isPaused()) return { kind: 'paused' };
    await stages.runSchedules();
    if (await isPaused()) return { kind: 'paused' };
    await stages.react();
    if (await isPaused()) return { kind: 'paused' };
    await stages.publishAgentRuns?.();
    if (await isPaused()) return { kind: 'paused' };
    return (
      (await runDeliveryPhase(stages, isPaused, signal, beforeDelivery)) ?? { kind: 'no-work' }
    );
  };
  // The API's manual Tick Now endpoint and the resident tick host share this
  // pipeline. Serializing all callers prevents them from racing the same run
  // claim, checkpoint, and workspace lifecycle within one Wake process.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    run(options, signal = new AbortController().signal, beforeDelivery) {
      const result = queue.then(() => runOnce(options, signal, beforeDelivery));
      // A rejected tick must not prevent the next requested tick from running.
      queue = result.catch(() => {});
      return result;
    },
  };
}

async function runDeliveryPhase(
  stages: RunnerPipelineStages,
  isPaused: () => Promise<boolean>,
  signal: AbortSignal,
  beforeDelivery: (() => Promise<void>) | undefined,
): Promise<RunnerPipelineResult | undefined> {
  if (await isPaused()) return { kind: 'paused' };
  await beforeDelivery?.();
  if (await isPaused()) return { kind: 'paused' };
  await stages.deliver(signal);
  if (await isPaused()) return { kind: 'paused' };
  await stages.react();
  return undefined;
}
