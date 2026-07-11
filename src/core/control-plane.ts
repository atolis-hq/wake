export function createControlPlane(deps: {
  tickRunner: { runTick: () => Promise<unknown> };
  intervalMs: number;
  // Ceiling for the idle-cadence backoff (#81): each consecutive non-`processed`
  // tick doubles the sleep from `intervalMs` up to this value. Defaults to
  // 16x intervalMs, matching the resolved default in domain/schema.ts.
  maxIntervalMs?: number;
  isPaused: () => Promise<boolean> | boolean;
  logger: {
    info: (message: string) => void;
    error: (message: string) => void;
  };
  sleep: (ms: number) => Promise<void>;
}) {
  let running = true;
  let lastStatus: string | undefined;
  let consecutiveIdleTicks = 0;
  const maxIntervalMs = deps.maxIntervalMs ?? deps.intervalMs * 16;

  function nextSleepMs(): number {
    const backoffMs = deps.intervalMs * 2 ** Math.min(consecutiveIdleTicks, 20);
    return Math.min(backoffMs, maxIntervalMs);
  }

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
        if (status === 'processed') {
          consecutiveIdleTicks = 0;
        } else {
          await deps.sleep(nextSleepMs());
          consecutiveIdleTicks += 1;
        }
      }
    },
  };
}
