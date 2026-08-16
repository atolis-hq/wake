import { BoardConditionValue as BoardConditionValues } from './transport-values.js';

export const BoardCondition = BoardConditionValues;

export type BoardCardCondition = (typeof BoardCondition)[keyof typeof BoardCondition];

export interface BoardCardActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
}

export interface BoardCardResponse {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardCardCondition;
  readonly frozen?: boolean;
  readonly awaitingApproval?: boolean;
  readonly workflowName?: string;
  readonly stage?: string;
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
}

export interface BoardResponse {
  readonly conditionCounts: Partial<Record<BoardCardCondition, number>>;
}
