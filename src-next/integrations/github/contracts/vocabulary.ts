import { MergeMethod } from '../../../activities/index.js';
import { defineClosedVocabulary, type ValueOf } from '../../../kernel/index.js';
import { adapterId, type AdapterId } from '../../contracts/identifiers.js';

export const GitHubAdapter: AdapterId = adapterId('github');

export const BuiltInAdapterId = { GitHub: GitHubAdapter } as const;

export const GitHubCheckRunStatus = defineClosedVocabulary({
  Queued: 'queued',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const);

export type GitHubCheckRunStatus = ValueOf<typeof GitHubCheckRunStatus>;

// GitHub's own issue/PR listing filter. Distinct from Wake's MatchMode, which
// happens to share the token "all" but means something unrelated.
export const GitHubListState = defineClosedVocabulary({
  All: 'all',
  Open: 'open',
  Closed: 'closed',
} as const);

export type GitHubListState = ValueOf<typeof GitHubListState>;

export const GitHubReviewState = defineClosedVocabulary({
  Approved: 'APPROVED',
  ChangesRequested: 'CHANGES_REQUESTED',
} as const);

export type GitHubReviewState = ValueOf<typeof GitHubReviewState>;

// Label families Wake owns and republishes. Nothing may tag intake from them: the
// adapter would observe Wake's own marker, re-route, and publish again.
export const GitHubWakeMarkerPrefix = defineClosedVocabulary({
  Status: 'wake:status.',
  Stage: 'wake:stage.',
  Workflow: 'wake:workflow.',
} as const);

export type GitHubWakeMarkerPrefix = ValueOf<typeof GitHubWakeMarkerPrefix>;

export function isGitHubWakeMarker(label: string): boolean {
  return Object.values(GitHubWakeMarkerPrefix).some((prefix) => label.startsWith(prefix));
}

// Facets a GitHub intake rule may constrain, and the observation fields they read.
export const GitHubIntakeFacet = {
  Kind: 'kind',
  Label: 'label',
  Assignee: 'assignee',
  Author: 'author',
} as const;

export const UnknownGitHubIdentity = 'unknown-github-identity';

export const UnknownGitHubRevision = 'unknown-github-revision';

export const GitHubOutboundAction = {
  Approve: 'approve',
  Merge: MergeMethod.Merge,
  Status: 'status',
  Reply: 'reply',
} as const;

export type GitHubOutboundAction = ValueOf<typeof GitHubOutboundAction>;
