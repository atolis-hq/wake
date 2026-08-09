export interface IntakePipelineStages {
  readonly isPaused?: () => Promise<boolean>;
  readonly catchUpProjections: () => Promise<void>;
  readonly poll: (signal: AbortSignal) => Promise<number>;
  readonly translateInbound: () => Promise<number>;
}

export interface IntakeCycleResult {
  readonly processed: boolean;
}

export interface IntakePipeline {
  run(signal: AbortSignal): Promise<IntakeCycleResult>;
}

/**
 * Runs the externally-rate-limited half of a Wake tick: poll and translate
 * inbound. Kept separate from RunnerPipeline so its host can back off when
 * idle without slowing down dispatch/delivery, which never touch a
 * rate-limited external API.
 */
export function createIntakePipeline(stages: IntakePipelineStages): IntakePipeline {
  return {
    async run(signal) {
      if (await stages.isPaused?.()) return { processed: false };
      await stages.catchUpProjections();
      try {
        const polled = await stages.poll(signal);
        const translated = await stages.translateInbound();
        return { processed: polled > 0 || translated > 0 };
      } finally {
        await stages.catchUpProjections();
      }
    },
  };
}
