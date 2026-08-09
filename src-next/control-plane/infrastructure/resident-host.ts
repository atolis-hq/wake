import { HostStopReason, type HostBudget, type HostResult } from '../contracts/commands.js';

interface BoundedHost {
  run(budget: HostBudget): Promise<HostResult>;
}

export interface ResidentCadence {
  // Cycles in a row with no progress, whether idle or errored — resets to 0
  // the moment any cycle progresses.
  readonly consecutiveIdleTicks: number;
  // Cycles in a row that threw, a strict subset of consecutiveIdleTicks —
  // resets to 0 on ANY cycle that completes without throwing, progress or
  // not. Lets a sleep strategy back off specifically on repeated failures
  // (e.g. a rate-limited external call) without also slowing down ordinary
  // "nothing to do locally" idling, which the failure counter never counts.
  readonly consecutiveErrorTicks: number;
}

export class ResidentHost {
  constructor(
    private readonly tick: BoundedHost,
    private readonly sleep: (
      signal: AbortSignal,
      cadence: ResidentCadence,
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
    let consecutiveErrorTicks = 0;
    while (!signal.aborted) {
      let madeProgress = false;
      let errored = false;
      try {
        const result = await this.tick.run(budget);
        madeProgress = result.advances > 0;
        total = {
          advances: total.advances + result.advances,
          runs: total.runs + result.runs,
          stoppedBecause: result.stoppedBecause,
        };
      } catch (error) {
        errored = true;
        await this.reportError(error);
      }
      consecutiveIdleTicks = madeProgress ? 0 : consecutiveIdleTicks + 1;
      consecutiveErrorTicks = errored ? consecutiveErrorTicks + 1 : 0;
      if (signal.aborted) break;
      await this.sleep(signal, { consecutiveIdleTicks, consecutiveErrorTicks });
    }
    return { ...total, stoppedBecause: HostStopReason.Shutdown };
  }
}
