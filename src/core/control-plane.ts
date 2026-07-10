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
  let lastStatus: string | undefined;

  return {
    stop() {
      running = false;
    },
    async runOnce() {
      if (await deps.isPaused()) {
        if (lastStatus !== 'paused') {
          deps.logger.info('[wake] status=paused');
          lastStatus = 'paused';
        }
        return { status: 'paused' as const };
      }

      const result = await deps.tickRunner.runTick();
      const status = (result as { status?: string } | null)?.status ?? 'unknown';
      if (status !== lastStatus) {
        deps.logger.info(`[wake] status=${status}`);
        lastStatus = status;
      }
      return result;
    },
    async start() {
      while (running) {
        let result: unknown;
        try {
          result = await this.runOnce();
        } catch (error) {
          deps.logger.error(error instanceof Error ? error.message : String(error));
        }

        if (!running) {
          break;
        }

        const status = (result as { status?: string } | null)?.status;
        if (status !== 'processed') {
          await deps.sleep(deps.intervalMs);
        }
      }
    },
  };
}
