import { WorkflowStatus } from '../../orchestration/index.js';
import {
  HostStopReason,
  type HostBudget,
  type HostResult,
  type PhasedAdvanceOnce,
} from '../contracts/commands.js';

export class TickHost {
  constructor(private readonly advance: PhasedAdvanceOnce) {}

  async run(budget: HostBudget, signal?: AbortSignal): Promise<HostResult> {
    const started = Date.now();
    let advances = 0;
    let runs = 0;
    const preparation = await prepareDispatch(this.advance, budget, started, signal);
    if (preparation !== undefined) return preparation;
    const dispatch = this.advance.dispatch;
    while (advances < budget.maxAdvances && runs < budget.maxRuns) {
      if (Date.now() - started >= budget.maxDurationMs)
        return { advances, runs, stoppedBecause: HostStopReason.Budget };
      const result = await (dispatch ?? this.advance)({ maxProgress: 1 }, signal);
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

async function prepareDispatch(
  advance: PhasedAdvanceOnce,
  budget: HostBudget,
  started: number,
  signal: AbortSignal | undefined,
): Promise<HostResult | undefined> {
  if (advance.dispatch === undefined || advance.maintain === undefined || budget.maxAdvances < 1)
    return undefined;
  if (Date.now() - started >= budget.maxDurationMs)
    return { advances: 0, runs: 0, stoppedBecause: HostStopReason.Budget };
  return (await advance.maintain(signal)).kind === 'paused'
    ? { advances: 0, runs: 0, stoppedBecause: HostStopReason.Paused }
    : undefined;
}
