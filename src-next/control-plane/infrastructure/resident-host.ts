import { HostStopReason, type HostBudget, type HostResult } from '../contracts/commands.js';

interface BoundedHost {
  run(budget: HostBudget): Promise<HostResult>;
}

export class ResidentHost {
  constructor(
    private readonly tick: BoundedHost,
    private readonly sleep: (signal: AbortSignal) => Promise<void> = async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  ) {}

  async run(signal: AbortSignal, budget: HostBudget): Promise<HostResult> {
    let total: HostResult = { advances: 0, runs: 0, stoppedBecause: HostStopReason.Shutdown };
    while (!signal.aborted) {
      const result = await this.tick.run(budget);
      total = {
        advances: total.advances + result.advances,
        runs: total.runs + result.runs,
        stoppedBecause: result.stoppedBecause,
      };
      if (signal.aborted) break;
      await this.sleep(signal);
    }
    return { ...total, stoppedBecause: HostStopReason.Shutdown };
  }
}
