import {
  type BoardActiveRunPhaseValue,
  BoardConditionValue as BoardConditionValues,
} from './transport-values.js';

export const BoardCondition = BoardConditionValues;

export type BoardCardCondition = (typeof BoardCondition)[keyof typeof BoardCondition];

export type BoardActiveRunPhase =
  (typeof BoardActiveRunPhaseValue)[keyof typeof BoardActiveRunPhaseValue];

export interface BoardCardActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly phase: BoardActiveRunPhase;
}

/** Progress of the delegated cohort a parent's workflow is waiting on. */
export interface BoardCardDelegationWait {
  /** Child work items in the cohort. */
  readonly total: number;
  /** Children whose results the cohort has accepted. */
  readonly finished: number;
  /** Children that failed or stopped and need attention. */
  readonly needsAttention: number;
  /** The parent handed a question about its children to a human. */
  readonly escalated?: boolean;
}

/** What a queued delegated child (reserved, not yet started) was declared to wait on. */
export interface BoardCardPrerequisiteWait {
  /** The orchestration reason, once prerequisite readiness blocked the child. */
  readonly reason?: string;
  /** Declared prerequisites; the journal does not say which one is unmet. */
  readonly prerequisites: readonly {
    readonly assignmentId: string;
    readonly output: string;
    readonly condition: string;
  }[];
}

export interface BoardCardResponse {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardCardCondition;
  /** Present on delegated children: the work item that delegated this one. */
  readonly parentWorkItemKey?: string;
  /** Present on a delegating parent: how many child work items it created. */
  readonly childCount?: number;
  /**
   * Present while the primary workflow waits on delegated children. Such a card
   * is Active unless a child is blocked or the parent escalated (Needs input).
   */
  readonly delegationWait?: BoardCardDelegationWait;
  /** Present on a queued delegated child that has not started its workflow. */
  readonly prerequisiteWait?: BoardCardPrerequisiteWait;
  /** The card's workflow instance was superseded; it is shown as finished. */
  readonly superseded?: boolean;
  readonly frozen?: boolean;
  /**
   * Present on delegated work held because an ancestor is frozen: the key of the
   * nearest frozen ancestor. Such work records no freeze of its own.
   */
  readonly frozenAncestorWorkItemKey?: string;
  readonly awaitingApproval?: boolean;
  /** Whether the primary workflow needs a gate-budget extension to continue. */
  readonly extendEligible?: boolean;
  readonly workflowName?: string;
  readonly stage?: string;
  /** Why the primary workflow is blocked, when it requires operator intervention. */
  readonly blockReason?: string;
  readonly retryCondition?: string;
  readonly dwellSince: string;
  readonly runCount: number;
  readonly activeRuns?: Readonly<Record<string, BoardCardActiveRun>>;
  readonly lastRunAt?: string;
  readonly lastRunAgeMs?: number;
  readonly lastRunOutcome?: string;
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalCostUsd: number;
  readonly totalDurationMs: number;
  readonly externalRef?: string;
  readonly repository?: string;
}

export interface BoardResponse {
  readonly conditionCounts: Partial<Record<BoardCardCondition, number>>;
}
