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
  const isPaused = async () => (await stages.isPaused?.()) ?? false;
  return {
    async run(options, signal = new AbortController().signal) {
      if (await isPaused()) return { kind: 'paused' };
      await stages.catchUpProjections();
      try {
        if (await isPaused()) return { kind: 'paused' };
        await stages.runSchedules();
        if (await isPaused()) return { kind: 'paused' };
        await stages.react();
        if (await isPaused()) return { kind: 'paused' };
        const result = await stages.advance(options);
        if (await isPaused()) return { kind: 'paused' };
        await stages.catchUpProjections();
        if (await isPaused()) return { kind: 'paused' };
        await stages.deliver(signal);
        if (await isPaused()) return { kind: 'paused' };
        await stages.catchUpProjections();
        if (await isPaused()) return { kind: 'paused' };
        await stages.react();
        return result;
      } finally {
        if (!(await isPaused())) await stages.catchUpProjections();
      }
    },
  };
}
