import { ReviewActorKind, ReviewerAuthorizationSource } from '../../../activities/index.js';
import { EventActorKind, EventSourceKind } from '../../../kernel/index.js';
import { createGitHubEventData } from '../contracts/event-factory.js';
import { GitHubEventType, type GitHubAdapterEventData } from '../contracts/events.js';
import { formatGitHubResourceKey } from '../contracts/external-key.js';
import type { GitHubPullRequestPayload, GitHubReviewPayload } from '../contracts/payloads.js';
import {
  GitHubBuiltInCommand,
  GitHubReviewState,
  UnknownGitHubIdentity,
} from '../contracts/vocabulary.js';

export function githubReviewObservation(input: {
  readonly repository: string;
  readonly pullRequest: GitHubPullRequestPayload;
  readonly review: GitHubReviewPayload;
  readonly authorizedReviewers: readonly string[];
}): readonly Extract<
  GitHubAdapterEventData,
  { eventType: typeof GitHubEventType.CommentObserved }
>[] {
  const body = input.review.body?.trim();
  const command = reviewCommand(input.review.state);
  const actorId = input.review.user?.login ?? UnknownGitHubIdentity;
  const key = formatGitHubResourceKey({
    ...parseRepository(input.repository),
    number: input.pullRequest.number,
  });
  const draft = (eventId: string, content: string) =>
    createGitHubEventData({
      eventId,
      eventType: GitHubEventType.CommentObserved,
      occurredAt: input.review.submitted_at,
      correlationId: `github:${key}`,
      causationId: `github:review:${input.review.id}`,
      actor: { kind: EventActorKind.Integration, id: 'github' },
      source: { kind: EventSourceKind.Adapter, id: 'github' },
      payload: {
        externalKey: key,
        reviewKind: 'formal' as const,
        body: content,
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
  return [
    ...(body === undefined || body.length === 0
      ? []
      : [
          draft(`github:review-feedback:${key}:${input.review.id}:${input.review.commit_id}`, body),
        ]),
    ...(command === null
      ? []
      : [
          draft(
            `github:review:${key}:${input.review.id}:${input.review.state}:${input.review.commit_id}`,
            command,
          ),
        ]),
  ];
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

function reviewCommand(
  state: string,
): typeof GitHubBuiltInCommand.Accepted | typeof GitHubBuiltInCommand.Changes | null {
  if (state === GitHubReviewState.Approved) return GitHubBuiltInCommand.Accepted;
  return state === GitHubReviewState.ChangesRequested ? GitHubBuiltInCommand.Changes : null;
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
