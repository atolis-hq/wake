import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';

export const DeliveryState = defineClosedVocabulary({
  Confirmed: 'confirmed',
  Failed: 'failed',
  Ambiguous: 'ambiguous',
} as const);
export type DeliveryState = ValueOf<typeof DeliveryState>;
