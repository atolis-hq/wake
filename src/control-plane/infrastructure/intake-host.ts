import { HostStopReason, type HostBudget, type HostResult } from '../contracts/commands.js';

export interface IntakeCycle {
  (signal: AbortSignal): Promise<{ readonly processed: boolean }>;
}

/**
 * Bounded host for IntakePipeline. Unlike TickHost, one cycle is always
 * exactly one poll-and-translate pass — there's no Advancement to loop
 * within a budget, and AdvanceResult's `progressed` variant requires an
 * activationId/runId that intake has no honest value for. ResidentHost
 * only needs `advances > 0` to decide whether its next sleep resets to the
 * fast end of backoff, which `processed` maps onto directly.
 */
export class IntakeHost {
  constructor(private readonly cycle: IntakeCycle) {}

  async run(_budget: HostBudget): Promise<HostResult> {
    const controller = new AbortController();
    const { processed } = await this.cycle(controller.signal);
    return {
      advances: processed ? 1 : 0,
      runs: 0,
      stoppedBecause: processed ? HostStopReason.Budget : HostStopReason.Idle,
    };
  }
}
