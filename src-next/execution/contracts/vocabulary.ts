import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const RunStatus = defineClosedVocabulary({
  Started: 'started',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Ambiguous: 'ambiguous',
} as const);
export type RunStatus = ValueOf<typeof RunStatus>;
export type FinishedRunStatus = Exclude<RunStatus, typeof RunStatus.Started>;
