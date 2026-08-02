import type { AdvanceOnce } from '../contracts/commands.js';
import type { AdvanceOptions, AdvanceResult } from '../contracts/views.js';

export interface TickPipelineStages {
  readonly catchUpProjections: () => Promise<void>;
  readonly poll: (signal: AbortSignal) => Promise<void>;
  readonly translateInbound: () => Promise<void>;
  readonly runSchedules: () => Promise<void>;
  readonly react: () => Promise<void>;
  readonly advance: AdvanceOnce;
  readonly deliver: (signal: AbortSignal) => Promise<void>;
}

export interface TickPipeline {
  run(options: AdvanceOptions, signal?: AbortSignal): Promise<AdvanceResult>;
}

/** Runs the durable host stages in the order required for one Wake tick. */
export function createTickPipeline(stages: TickPipelineStages): TickPipeline {
  return {
    async run(options, signal = new AbortController().signal) {
      await stages.catchUpProjections();
      await stages.poll(signal);
      await stages.translateInbound();
      await stages.runSchedules();
      await stages.react();
      const result = await stages.advance(options);
      await stages.catchUpProjections();
      await stages.deliver(signal);
      await stages.catchUpProjections();
      await stages.react();
      return result;
    },
  };
}
