import type {
  ActivationSchedulerSubscriber,
  AdvanceOnce,
  RunnerPipeline,
} from '../control-plane/index.js';

export interface RunnerTickRuntime {
  readonly runnerPipeline: RunnerPipeline;
  readonly activationSchedulerSubscriber: Pick<ActivationSchedulerSubscriber, 'poke'>;
}

/** One-shot ticks produce schedule/reactor facts before reconciling subscriber-owned activation work. */
export function createOneShotRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  return async (options) => {
    let scheduled: Awaited<ReturnType<typeof root.activationSchedulerSubscriber.poke>> | undefined;
    const pipeline = await root.runnerPipeline.run(options, undefined, async () => {
      scheduled = await root.activationSchedulerSubscriber.poke(options);
    });
    if (pipeline.kind === 'paused') return pipeline;
    if (scheduled === undefined)
      throw new Error('Subscriber scheduler did not run before delivery');
    return scheduled;
  };
}

/** Resident scheduling is owned by the durable subscriber, never its tick loop. */
export function createResidentRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  return (options) => root.runnerPipeline.run(options);
}
