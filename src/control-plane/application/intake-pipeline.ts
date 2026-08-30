export interface IntakePipelineStages {
  readonly isPaused?: () => Promise<boolean>;
  readonly poll: (signal: AbortSignal) => Promise<number>;
}

export interface IntakeCycleResult {
  readonly processed: boolean;
}

export interface IntakePipeline {
  run(signal: AbortSignal): Promise<IntakeCycleResult>;
}

/**
 * Runs the externally-rate-limited half of a Wake tick: poll. Incremental
 * inbound translation is independently supervised by the Eventing runtime.
 * It stays separate from RunnerPipeline so its host can back off when
 * idle without slowing down dispatch/delivery, which never touch a
 * rate-limited external API.
 */
export function createIntakePipeline(stages: IntakePipelineStages): IntakePipeline {
  const isPaused = async () => (await stages.isPaused?.()) ?? false;
  return {
    async run(signal) {
      if (await isPaused()) return { processed: false };
      const polled = await stages.poll(signal);
      return { processed: polled > 0 };
    },
  };
}
