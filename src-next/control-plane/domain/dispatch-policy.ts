export interface DispatchCandidate {
  readonly workItemId: string;
  readonly activationId: string;
  readonly requestedPosition: number;
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
          left.requestedPosition - right.requestedPosition ||
          left.activationId.localeCompare(right.activationId),
      )
      .slice(0, this.options.maxDispatches);
  }
}
