import type {
  ActivationSchedulerSubscriber,
  AdvanceOnce,
  RunnerPipeline,
} from '../control-plane/index.js';

export interface RunnerTickRuntime {
  readonly runnerPipeline: RunnerPipeline;
  readonly activationSchedulerSubscriber: Pick<ActivationSchedulerSubscriber, 'poke'>;
}

export interface OneShotRunnerTickRuntime extends RunnerTickRuntime {
  readonly projectionSubscriptions: {
    catchUpOnce(signal?: AbortSignal): Promise<number>;
  };
}

export async function withFinalProjectionCatchUp<T>(
  operation: () => Promise<T>,
  catchUp: () => Promise<unknown>,
): Promise<T> {
  let result: T | undefined;
  let operationFailed = false;
  let primaryFailure: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    primaryFailure = error;
  }
  let catchUpFailed = false;
  let catchUpFailure: unknown;
  try {
    await catchUp();
  } catch (error) {
    catchUpFailed = true;
    catchUpFailure = error;
  }
  if (operationFailed && catchUpFailed)
    throw new AggregateError(
      [primaryFailure, catchUpFailure],
      'Operation and final projection catch-up failed',
    );
  if (operationFailed) throw primaryFailure;
  if (catchUpFailed) throw catchUpFailure;
  return result!;
}

/** One-shot ticks produce schedule/reactor facts before reconciling subscriber-owned activation work. */
export function createOneShotRunnerAdvance(root: OneShotRunnerTickRuntime): AdvanceOnce {
  return (options) =>
    withFinalProjectionCatchUp(
      async () => {
        let scheduled:
          Awaited<ReturnType<typeof root.activationSchedulerSubscriber.poke>> | undefined;
        await root.projectionSubscriptions.catchUpOnce();
        const pipeline = await root.runnerPipeline.run(options, undefined, async () => {
          await root.projectionSubscriptions.catchUpOnce();
          scheduled = await root.activationSchedulerSubscriber.poke(options);
        });
        if (pipeline.kind === 'paused') return pipeline;
        if (scheduled === undefined)
          throw new Error('Subscriber scheduler did not run before delivery');
        return scheduled;
      },
      () => root.projectionSubscriptions.catchUpOnce(),
    );
}

/** Resident scheduling is owned by the durable subscriber, never its tick loop. */
export function createResidentRunnerAdvance(root: RunnerTickRuntime): AdvanceOnce {
  return (options) => root.runnerPipeline.run(options);
}
