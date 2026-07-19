export function createControlPlane(deps: {
  tickRunner: {
    runTick: () => Promise<unknown>;
    runIntakeTick?: () => Promise<unknown>;
    runRunnerTick?: () => Promise<unknown>;
  };
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
  let lastIntakeStatus: string | undefined;
  let lastRunnerStatus: string | undefined;
  let consecutiveIdleTicks = 0;
  let consecutiveIntakeIdleTicks = 0;
  let consecutiveRunnerIdleTicks = 0;
  const maxIntervalMs = deps.maxIntervalMs ?? deps.intervalMs * 16;

  function nextSleepMs(consecutiveTicks: number): number {
    const backoffMs = deps.intervalMs * 2 ** Math.min(consecutiveTicks, 20);
    return Math.min(backoffMs, maxIntervalMs);
  }

  async function isPaused(): Promise<boolean> {
    return Boolean(await deps.isPaused());
  }

  function logStatus(message: string, status: string, last: string | undefined): string {
    if (status !== last) {
      deps.logger.info(message);
    }
    return status;
  }

  async function runLoopOnce(input: {
    run: () => Promise<unknown>;
    label: 'intake' | 'runner';
  }): Promise<unknown> {
    if (await isPaused()) {
      const status = 'paused';
      if (input.label === 'intake') {
        lastIntakeStatus = logStatus('[wake] intake status=paused', status, lastIntakeStatus);
      } else {
        lastRunnerStatus = logStatus('[wake] runner status=paused', status, lastRunnerStatus);
      }
      return { status: 'paused' as const };
    }

    const result = await input.run();
    const status = (result as { status?: string } | null)?.status ?? 'unknown';
    if (input.label === 'intake') {
      lastIntakeStatus = logStatus(`[wake] intake status=${status}`, status, lastIntakeStatus);
    } else {
      lastRunnerStatus = logStatus(`[wake] runner status=${status}`, status, lastRunnerStatus);
    }
    return result;
  }

  async function startLoop(input: {
    run: () => Promise<unknown>;
    label: 'intake' | 'runner';
    getIdleTicks: () => number;
    setIdleTicks: (value: number) => void;
  }): Promise<void> {
    while (running) {
      let result: unknown;
      try {
        result = await runLoopOnce({ run: input.run, label: input.label });
      } catch (error) {
        deps.logger.error(error instanceof Error ? error.message : String(error));
      }

      if (!running) {
        break;
      }

      const status = (result as { status?: string } | null)?.status;
      if (status === 'processed') {
        input.setIdleTicks(0);
      } else {
        await deps.sleep(nextSleepMs(input.getIdleTicks()));
        input.setIdleTicks(input.getIdleTicks() + 1);
      }
    }
  }

  return {
    stop() {
      running = false;
    },
    async runOnce() {
      if (await isPaused()) {
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
      if (
        deps.tickRunner.runIntakeTick !== undefined &&
        deps.tickRunner.runRunnerTick !== undefined
      ) {
        await Promise.all([
          startLoop({
            run: deps.tickRunner.runIntakeTick,
            label: 'intake',
            getIdleTicks: () => consecutiveIntakeIdleTicks,
            setIdleTicks: (value) => {
              consecutiveIntakeIdleTicks = value;
            },
          }),
          startLoop({
            run: deps.tickRunner.runRunnerTick,
            label: 'runner',
            getIdleTicks: () => consecutiveRunnerIdleTicks,
            setIdleTicks: (value) => {
              consecutiveRunnerIdleTicks = value;
            },
          }),
        ]);
        return;
      }

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
          await deps.sleep(nextSleepMs(consecutiveIdleTicks));
          consecutiveIdleTicks += 1;
        }
      }
    },
  };
}
