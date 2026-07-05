export function createControlPlane(deps: {
  tickRunner: { runTick: () => Promise<unknown> };
  intervalMs: number;
  isPaused: () => Promise<boolean> | boolean;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  sleep: (ms: number) => Promise<void>;
}) {
  let running = true;

  return {
    stop() {
      running = false;
    },
    async runOnce() {
      if (await deps.isPaused()) {
        deps.logger.info('Wake is paused');
        return { status: 'paused' as const };
      }

      return deps.tickRunner.runTick();
    },
    async start() {
      while (running) {
        try {
          await this.runOnce();
        } catch (error) {
          deps.logger.error(error instanceof Error ? error.message : String(error));
        }

        if (!running) {
          break;
        }

        await deps.sleep(deps.intervalMs);
      }
    },
  };
}
