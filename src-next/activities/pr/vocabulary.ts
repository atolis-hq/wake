import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';

export const PullRequestState = defineClosedVocabulary({
  Open: 'open',
  Closed: 'closed',
  Merged: 'merged',
} as const);
export type PullRequestState = ValueOf<typeof PullRequestState>;

export const PullRequestCheckState = defineClosedVocabulary({
  Unknown: 'unknown',
  Pending: 'pending',
  Passing: 'passing',
  Failing: 'failing',
} as const);
export type PullRequestCheckState = ValueOf<typeof PullRequestCheckState>;

export const MergeMethod = defineClosedVocabulary({
  Merge: 'merge',
  Squash: 'squash',
  Rebase: 'rebase',
} as const);
export type MergeMethod = ValueOf<typeof MergeMethod>;

export const PullRequestDenialCode = defineClosedVocabulary({
  MissingResource: 'missing-resource',
  AmbiguousResource: 'ambiguous-resource',
  CorrelationConflict: 'correlation-conflict',
  Closed: 'closed',
  StaleApproval: 'stale-approval',
  ChecksPending: 'checks-pending',
  ChecksFailing: 'checks-failing',
  UntrustedActor: 'untrusted-actor',
} as const);
export type PullRequestDenialCode = ValueOf<typeof PullRequestDenialCode>;
