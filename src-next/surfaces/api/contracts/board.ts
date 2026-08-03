import { BoardConditionValue as BoardConditionValues } from './transport-values.js';

export const BoardCondition = BoardConditionValues;

export type BoardCardCondition = (typeof BoardCondition)[keyof typeof BoardCondition];

export interface BoardCardActiveRun {
  readonly action: string;
  readonly runnerName?: string;
  readonly startedAt: string;
}

export interface BoardCardResponse {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardCardCondition;
  readonly awaitingApproval?: boolean;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly dwellSince: string;
  readonly runCount: number;
  readonly activeRun?: BoardCardActiveRun;
  readonly lastRunAt?: string;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly externalRef?: string;
}

export interface BoardResponse {
  readonly conditionCounts: Partial<Record<BoardCardCondition, number>>;
}
