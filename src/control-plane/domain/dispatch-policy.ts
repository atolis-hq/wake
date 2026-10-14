export interface DispatchPriority {
  readonly remainingAgentSteps: number;
  readonly watchDriven: boolean;
  readonly retried: boolean;
}

export interface DispatchCandidate {
  readonly workItemId: string;
  readonly activationId: string;
  readonly requestedPosition: number;
  readonly priority: DispatchPriority;
  readonly hasActiveRun: boolean;
  readonly cancelled: boolean;
}

export interface DispatchPolicyOptions {
  readonly maxDispatches: number;
}

export interface DispatchPolicyState {
  readonly blocked?: boolean;
}

export class DispatchPolicy {
  constructor(private readonly options: DispatchPolicyOptions) {}

  select(
    candidates: readonly DispatchCandidate[],
    state: DispatchPolicyState = {},
  ): readonly DispatchCandidate[] {
    if (state.blocked === true || this.options.maxDispatches <= 0) return [];
    return [...candidates]
      .filter((candidate) => !candidate.cancelled && !candidate.hasActiveRun)
      .sort(
        (left, right) =>
          left.priority.remainingAgentSteps - right.priority.remainingAgentSteps ||
          Number(right.priority.watchDriven) - Number(left.priority.watchDriven) ||
          Number(right.priority.retried) - Number(left.priority.retried) ||
          left.requestedPosition - right.requestedPosition ||
          left.activationId.localeCompare(right.activationId),
      )
      .slice(0, this.options.maxDispatches);
  }
}
