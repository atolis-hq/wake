import { HostStopReason, type HostBudget, type HostResult } from '../contracts/commands.js';

interface BoundedHost {
  run(budget: HostBudget): Promise<HostResult>;
}

export class ResidentHost {
  constructor(
    private readonly tick: BoundedHost,
    private readonly sleep: (
      signal: AbortSignal,
      consecutiveIdleTicks: number,
    ) => Promise<void> = async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    private readonly reportError: (error: unknown) => Promise<void> = async () => {},
  ) {}

  async run(signal: AbortSignal, budget: HostBudget): Promise<HostResult> {
    let total: HostResult = { advances: 0, runs: 0, stoppedBecause: HostStopReason.Shutdown };
    let consecutiveIdleTicks = 0;
    while (!signal.aborted) {
      let madeProgress = false;
      try {
        const result = await this.tick.run(budget);
        madeProgress = result.advances > 0;
        total = {
          advances: total.advances + result.advances,
          runs: total.runs + result.runs,
          stoppedBecause: result.stoppedBecause,
        };
      } catch (error) {
        await this.reportError(error);
      }
      consecutiveIdleTicks = madeProgress ? 0 : consecutiveIdleTicks + 1;
      if (signal.aborted) break;
      await this.sleep(signal, consecutiveIdleTicks);
    }
    return { ...total, stoppedBecause: HostStopReason.Shutdown };
  }
}
