import type {
  ActivationSchedulerSubscriber,
  AdvanceOnce,
  RunnerPipeline,
} from '../control-plane/index.js';

export interface RunnerTickRuntime {
  readonly runnerPipeline: RunnerPipeline;
  readonly activationSchedulerSubscriber?: Pick<ActivationSchedulerSubscriber, 'poke'>;
}

/** One-shot ticks produce schedule/reactor facts before reconciling subscriber-owned activation work. */
export function createOneShotRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  const subscriber = root.activationSchedulerSubscriber;
  if (subscriber === undefined) return (options) => root.runnerPipeline.run(options);
  return async (options) => {
    await root.runnerPipeline.run(options);
    return subscriber.poke(options);
  };
}

/** Resident scheduling is owned by the durable subscriber, never its tick loop. */
export function createResidentRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  return (options) => root.runnerPipeline.run(options);
}
