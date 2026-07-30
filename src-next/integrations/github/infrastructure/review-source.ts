import { createEventDraft, entityRef, type EventDraft } from '../../../kernel/index.js';
import type { GitHubPullRequestPayload, GitHubReviewPayload } from '../contracts/payloads.js';

export function githubReviewObservation(input: {
  readonly repository: string;
  readonly pullRequest: GitHubPullRequestPayload;
  readonly review: GitHubReviewPayload;
  readonly authorizedReviewers: readonly string[];
}): EventDraft | null {
  const command = reviewCommand(input.review.state);
  if (command === null) return null;
  const actorId = input.review.user?.login ?? 'unknown';
  const key = `${input.repository}#${input.pullRequest.number}`;
  return createEventDraft({
    eventId: `github:review:${key}:${input.review.id}:${input.review.state}:${input.review.commit_id}`,
    eventType: 'integration.github.comment-observed',
    occurredAt: input.review.submitted_at,
    correlationId: `github:${key}`,
    causationId: `github:review:${input.review.id}`,
    actor: { kind: 'integration', id: 'github' },
    source: { kind: 'adapter', id: 'github' },
    stream: entityRef('integration', 'github'),
    payload: {
      externalKey: key,
      body: command,
      revision: input.review.commit_id,
      actor: {
        id: actorId,
        kind: input.review.user?.type === 'Bot' ? 'bot' : 'human',
      },
      resourceAuthorId: input.pullRequest.user?.login ?? 'unknown',
      authorization: configuredAuthorization(actorId, input.authorizedReviewers),
      raw: { reviewId: input.review.id, state: input.review.state },
    },
  });
}

function configuredAuthorization(actorId: string, reviewers: readonly string[]) {
  const reviewerId = reviewers.find((reviewer) => sameIdentity(reviewer, actorId));
  return reviewerId === undefined
    ? ({ source: 'none' } as const)
    : ({ source: 'configured-reviewer', reviewerId } as const);
}

function reviewCommand(state: string): '/accepted' | '/changes' | null {
  if (state === 'APPROVED') return '/accepted';
  return state === 'CHANGES_REQUESTED' ? '/changes' : null;
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
