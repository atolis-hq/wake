import type { AdvanceOnce } from '../contracts/commands.js';
import type { AdvanceOptions, AdvanceResult } from '../contracts/views.js';

export interface RunnerPipelineStages {
  readonly isPaused?: () => Promise<boolean>;
  readonly catchUpProjections: () => Promise<void>;
  readonly runSchedules: () => Promise<void>;
  readonly react: () => Promise<void>;
  readonly advance: AdvanceOnce;
  readonly deliver: (signal: AbortSignal) => Promise<void>;
}

export interface RunnerPipeline {
  run(options: AdvanceOptions, signal?: AbortSignal): Promise<AdvanceResult>;
}

/**
 * Runs the internal half of a Wake tick: schedules, reactors, Advancement,
 * and delivery. None of this touches a rate-limited external poll, so its
 * host runs on a fast, un-backed-off cadence — see IntakePipeline for the
 * half that does need backoff.
 */
export function createRunnerPipeline(stages: RunnerPipelineStages): RunnerPipeline {
  return {
    async run(options, signal = new AbortController().signal) {
      if (await stages.isPaused?.()) return { kind: 'paused' };
      await stages.catchUpProjections();
      try {
        await stages.runSchedules();
        await stages.react();
        const result = await stages.advance(options);
        await stages.catchUpProjections();
        await stages.deliver(signal);
        await stages.catchUpProjections();
        await stages.react();
        return result;
      } finally {
        await stages.catchUpProjections();
      }
    },
  };
}
