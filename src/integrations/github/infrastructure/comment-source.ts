import {
  ReviewerAuthorizationSource,
  type ReviewerAuthorizationEvidence,
} from '../../../activities/index.js';
import { recognizedCommand } from '../application/inbound-comment-syntax.js';
import type { GitHubIssueCommentPayload } from '../contracts/payloads.js';
import { issueCommentObservation } from './issue-source.js';
import { mergeBatches, reportPartialPollFailure, type PollBatch } from './poll-watermark.js';
import { githubReviewObservation } from './review-source.js';
import type { RepositoryPollContext } from './source-contracts.js';

export async function reviewCommentEventsFor(
  context: RepositoryPollContext,
  pullRequests: readonly Parameters<typeof githubReviewObservation>[0]['pullRequest'][],
): Promise<PollBatch> {
  if (context.client.listReviewComments === undefined) return { drafts: [], succeeded: true };
  const items = await Promise.all(
    pullRequests.map(async (pullRequest): Promise<PollBatch> => {
      try {
        const comments = await context.client.listReviewComments!(
          context.owner,
          context.repo,
          pullRequest.number,
          context.config.polling.commentPageSize,
          context.config.polling.maxPerRepo,
        );
        return {
          succeeded: true,
          drafts: (
            await Promise.all(
              comments.map((comment) =>
                issueCommentEventsForComment(context, pullRequest, comment),
              ),
            )
          ).flat(),
        };
      } catch {
        reportPartialPollFailure(
          context.repository,
          `pull-request review comments #${pullRequest.number}`,
        );
        return { drafts: [], succeeded: false };
      }
    }),
  );
  return mergeBatches(items);
}

export async function reviewEventsFor(
  context: RepositoryPollContext,
  pullRequests: readonly Parameters<typeof githubReviewObservation>[0]['pullRequest'][],
): Promise<PollBatch> {
  const items = await Promise.all(
    pullRequests.map(async (pullRequest): Promise<PollBatch> => {
      try {
        const reviews = await context.client.listReviews(
          context.owner,
          context.repo,
          pullRequest.number,
          context.config.polling.commentPageSize,
          context.config.polling.maxPerRepo,
        );
        return {
          succeeded: true,
          drafts: reviews.flatMap((review) =>
            githubReviewObservation({
              repository: context.repository,
              pullRequest,
              review,
              authorizedReviewers: [],
            }),
          ),
        };
      } catch {
        reportPartialPollFailure(context.repository, `pull-request reviews #${pullRequest.number}`);
        return { drafts: [], succeeded: false };
      }
    }),
  );
  return mergeBatches(items);
}

export async function issueCommentEventsFor(
  context: RepositoryPollContext,
  issues: readonly Parameters<typeof issueCommentObservation>[0]['issue'][],
  since: string | undefined,
): Promise<PollBatch> {
  const items = await Promise.all(
    issues.map(async (issue): Promise<PollBatch> => {
      try {
        const comments = await context.client.listIssueComments(
          context.owner,
          context.repo,
          issue.number,
          context.config.polling.commentPageSize,
          since,
          context.config.polling.maxPerRepo,
        );
        return {
          succeeded: true,
          drafts: (
            await Promise.all(
              comments.map((comment) => issueCommentEventsForComment(context, issue, comment)),
            )
          ).flat(),
        };
      } catch {
        reportPartialPollFailure(context.repository, `issue comments #${issue.number}`);
        return { drafts: [], succeeded: false };
      }
    }),
  );
  return mergeBatches(items);
}

async function issueCommentEventsForComment(
  context: RepositoryPollContext,
  issue: Pick<Parameters<typeof issueCommentObservation>[0]['issue'], 'number'>,
  comment: GitHubIssueCommentPayload,
) {
  const authorization = await commandAuthorization(context, comment);
  const event = issueCommentObservation({
    repository: context.repository,
    issue,
    comment,
    ...(authorization === undefined ? {} : { authorization }),
    ...(context.adapter === undefined ? {} : { adapter: context.adapter }),
  });
  return event === null ? [] : [event];
}

async function commandAuthorization(
  context: RepositoryPollContext,
  comment: GitHubIssueCommentPayload,
): Promise<ReviewerAuthorizationEvidence | undefined> {
  if (
    comment.body === null ||
    comment.body === undefined ||
    recognizedCommand(comment.body) === null
  )
    return undefined;
  const login = comment.user?.login;
  if (login === undefined || context.client.collaboratorPermission === undefined)
    return { source: ReviewerAuthorizationSource.None };
  try {
    return {
      source: ReviewerAuthorizationSource.ProviderPermission,
      permission: await context.client.collaboratorPermission(context.owner, context.repo, login),
    };
  } catch {
    return { source: ReviewerAuthorizationSource.None };
  }
}
