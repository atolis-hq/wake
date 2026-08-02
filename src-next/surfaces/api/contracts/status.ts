import type { BoardCardCondition } from './board.js';

export interface StatusResponse {
  readonly conditionCounts: Partial<Record<BoardCardCondition, number>>;
}
