import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';

export const GitHubCheckRunStatus = defineClosedVocabulary({
  Queued: 'queued',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const);
export type GitHubCheckRunStatus = ValueOf<typeof GitHubCheckRunStatus>;

export const GitHubReviewState = defineClosedVocabulary({
  Approved: 'APPROVED',
  ChangesRequested: 'CHANGES_REQUESTED',
} as const);
export type GitHubReviewState = ValueOf<typeof GitHubReviewState>;

export const UnknownGitHubIdentity = 'unknown-github-identity';
export const UnknownGitHubRevision = 'unknown-github-revision';
