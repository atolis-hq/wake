import { ReviewActorKind, ReviewerAuthorizationSource } from '../../../activities/index.js';
import { createEventDraft, EventActorKind, EventSourceKind } from '../../../kernel/index.js';
import { integrationStream } from '../../contracts/streams.js';
import { GitHubEventType, type GitHubAdapterEventDraft } from '../contracts/events.js';
import { formatGitHubResourceKey } from '../contracts/external-key.js';
import type { GitHubPullRequestPayload, GitHubReviewPayload } from '../contracts/payloads.js';
import {
  GitHubAdapter,
  GitHubReviewState,
  UnknownGitHubIdentity,
} from '../contracts/vocabulary.js';

export function githubReviewObservation(input: {
  readonly repository: string;
  readonly pullRequest: GitHubPullRequestPayload;
  readonly review: GitHubReviewPayload;
  readonly authorizedReviewers: readonly string[];
}): Extract<GitHubAdapterEventDraft, { eventType: typeof GitHubEventType.CommentObserved }> | null {
  const command = reviewCommand(input.review.state);
  if (command === null) return null;
  const actorId = input.review.user?.login ?? UnknownGitHubIdentity;
  const key = formatGitHubResourceKey({
    ...parseRepository(input.repository),
    number: input.pullRequest.number,
  });
  return createEventDraft({
    eventId: `github:review:${key}:${input.review.id}:${input.review.state}:${input.review.commit_id}`,
    eventType: GitHubEventType.CommentObserved,
    occurredAt: input.review.submitted_at,
    correlationId: `github:${key}`,
    causationId: `github:review:${input.review.id}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: 'github' },
    stream: integrationStream(GitHubAdapter),
    payload: {
      externalKey: key,
      reviewKind: 'formal',
      body: command,
      revision: input.review.commit_id,
      actor: {
        id: actorId,
        kind: input.review.user?.type === 'Bot' ? ReviewActorKind.Bot : ReviewActorKind.Human,
      },
      resourceAuthorId: input.pullRequest.user?.login ?? UnknownGitHubIdentity,
      authorization: configuredAuthorization(actorId, input.authorizedReviewers),
      raw: { reviewId: input.review.id, state: input.review.state },
    },
  });
}

function parseRepository(repository: string): { readonly owner: string; readonly repo: string } {
  const [owner, repo, ...extra] = repository.split('/');
  if (owner === undefined || repo === undefined || extra.length > 0)
    throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, repo };
}

function configuredAuthorization(actorId: string, reviewers: readonly string[]) {
  const reviewerId = reviewers.find((reviewer) => sameIdentity(reviewer, actorId));
  return reviewerId === undefined
    ? ({ source: ReviewerAuthorizationSource.None } as const)
    : ({ source: ReviewerAuthorizationSource.ConfiguredReviewer, reviewerId } as const);
}

function reviewCommand(state: string): '/accepted' | '/changes' | null {
  if (state === GitHubReviewState.Approved) return '/accepted';
  return state === GitHubReviewState.ChangesRequested ? '/changes' : null;
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
