import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const SurfaceSessionAttribute = defineClosedVocabulary({
  Operator: 'operator',
} as const);

export type SurfaceSessionAttribute = ValueOf<typeof SurfaceSessionAttribute>;

export const SurfaceCookieSecurity = defineClosedVocabulary({
  Auto: 'auto',
} as const);

export type SurfaceCookieSecurity = ValueOf<typeof SurfaceCookieSecurity>;
