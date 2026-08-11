import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

// How an external resource (a GitHub issue today; any future adapter's
// ticket) concluded, independent of that provider's own vocabulary.
export const ExternalWorkOutcome = defineClosedVocabulary({
  Completed: 'completed',
  Cancelled: 'cancelled',
} as const);

export type ExternalWorkOutcome = ValueOf<typeof ExternalWorkOutcome>;
