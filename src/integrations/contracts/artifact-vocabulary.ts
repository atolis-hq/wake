import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const ArtifactVerificationResult = defineClosedVocabulary({
  NotFound: 'not-found',
  Ambiguous: 'ambiguous',
} as const);

export type ArtifactVerificationResult = ValueOf<typeof ArtifactVerificationResult>;

export const ArtifactVerificationStatus = defineClosedVocabulary({
  Failed: 'failed',
  Ambiguous: 'ambiguous',
} as const);

export type ArtifactVerificationStatus = ValueOf<typeof ArtifactVerificationStatus>;
