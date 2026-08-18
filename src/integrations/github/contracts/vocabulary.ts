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
export const GitHubWakeStatusLabel = defineClosedVocabulary({
  Working: 'working',
  AwaitingApproval: 'awaiting-approval',
  Blocked: 'blocked',
  Completed: 'completed',
  Failed: 'failed',
} as const);

export type GitHubWakeStatusLabel = ValueOf<typeof GitHubWakeStatusLabel>;

export const GitHubWakeMarkerPrefix = defineClosedVocabulary({
  Status: 'wake:status.',
  Stage: 'wake:stage.',
  Workflow: 'wake:workflow.',
} as const);

export type GitHubWakeMarkerPrefix = ValueOf<typeof GitHubWakeMarkerPrefix>;

const GitHubWakeMarkerNamespace = 'wake:';

export function isGitHubWakeMarker(label: string): boolean {
  return label.startsWith(GitHubWakeMarkerNamespace);
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
  EnableAutoMerge: 'enable-auto-merge',
  Merge: MergeMethod.Merge,
  Status: 'status',
  Reply: 'reply',
  Close: 'close',
} as const;

export type GitHubOutboundAction = ValueOf<typeof GitHubOutboundAction>;

// Comment-channel commands the GitHub adapter recognizes from human replies.
// /approved and /changes drive issue-review and PR-issue-comment signals;
// /accepted and /changes drive formal (native) PR review comments; /retry
// resumes a blocked/failed stage. Kept as the single source of truth for both
// recognition (inbound-comment-syntax.ts, review-command-translator.ts) and
// the commands/instructions surface, so the two cannot drift.
export const GitHubBuiltInCommand = defineClosedVocabulary({
  Approved: '/approved',
  Accepted: '/accepted',
  Changes: '/changes',
  Retry: '/retry',
} as const);

export type GitHubBuiltInCommand = ValueOf<typeof GitHubBuiltInCommand>;
