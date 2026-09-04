import { WorkflowStatus } from '../../orchestration/index.js';
import {
  HostStopReason,
  type AdvanceOnce,
  type HostBudget,
  type HostResult,
} from '../contracts/commands.js';

export class TickHost {
  constructor(private readonly advance: AdvanceOnce) {}

  async run(budget: HostBudget, signal?: AbortSignal): Promise<HostResult> {
    const started = Date.now();
    let advances = 0;
    let runs = 0;
    while (advances < budget.maxAdvances && runs < budget.maxRuns) {
      if (Date.now() - started >= budget.maxDurationMs)
        return { advances, runs, stoppedBecause: HostStopReason.Budget };
      const result = await this.advance({ maxProgress: 1 }, signal);
      if (result.kind === 'progressed') {
        advances += 1;
        runs += result.dispatched.length;
        continue;
      }
      return {
        advances,
        runs,
        stoppedBecause:
          result.kind === 'no-work'
            ? HostStopReason.Idle
            : result.kind === WorkflowStatus.Waiting
              ? HostStopReason.Waiting
              : result.kind === WorkflowStatus.Blocked
                ? HostStopReason.Blocked
                : HostStopReason.Budget,
      };
    }
    return { advances, runs, stoppedBecause: HostStopReason.Budget };
  }
}
