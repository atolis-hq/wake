import type {
  ActivationSchedulerSubscriber,
  AdvanceOnce,
  RunnerPipeline,
} from '../control-plane/index.js';

export interface RunnerTickRuntime {
  readonly runnerPipeline: RunnerPipeline;
  readonly activationSchedulerSubscriber?: ActivationSchedulerSubscriber;
}

/** One-shot ticks explicitly reconcile subscriber-owned activation work. */
export function createOneShotRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  if (root.activationSchedulerSubscriber === undefined)
    return (options) => root.runnerPipeline.run(options);
  return async (options) => {
    const [schedulerResult] = await Promise.all([
      root.activationSchedulerSubscriber!.poke(options),
      root.runnerPipeline.run(options),
    ]);
    return schedulerResult;
  };
}

/** Resident scheduling is owned by the durable subscriber, never its tick loop. */
export function createResidentRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  return (options) => root.runnerPipeline.run(options);
}
