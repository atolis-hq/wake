import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const WorkStatus = defineClosedVocabulary({
  Open: 'open',
  Closed: 'closed',
  Cancelled: 'cancelled',
} as const);
export type WorkStatus = ValueOf<typeof WorkStatus>;
