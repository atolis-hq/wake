import { BoardConditionValue as BoardConditionValues } from './transport-values.js';

export const BoardCondition = BoardConditionValues;

export type BoardCardCondition = (typeof BoardCondition)[keyof typeof BoardCondition];

export interface BoardCardResponse {
  readonly workItemKey: string;
  readonly workItemId: string;
  readonly objective: string;
  readonly condition: BoardCardCondition;
  readonly workflowName?: string;
  readonly stage?: string;
  readonly dwellSince: string;
  readonly runCount: number;
}

export interface BoardResponse {
  readonly conditionCounts: Partial<Record<BoardCardCondition, number>>;
}
