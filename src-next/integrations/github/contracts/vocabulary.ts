import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';
import { MergeMethod } from '../../../activities/index.js';
import { adapterId, type AdapterId } from '../../contracts/identifiers.js';

export const GitHubAdapter: AdapterId = adapterId('github');
export const BuiltInAdapterId = { GitHub: GitHubAdapter } as const;

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

export const GitHubOutboundAction = {
  Approve: 'approve',
  Merge: MergeMethod.Merge,
  Status: 'status',
  Reply: 'reply',
} as const;
export type GitHubOutboundAction = ValueOf<typeof GitHubOutboundAction>;
