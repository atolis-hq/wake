import type { AdapterId } from '../../contracts/identifiers.js';
import type { ExternalEventSource } from '../../contracts/intake.js';
import type { GitHubConfig } from '../contracts/config.js';
import { GitHubEventType } from '../contracts/events.js';
import type { GitHubIssueCommentPayload, GitHubReviewPayload } from '../contracts/payloads.js';
import { issueCommentObservation, issueObservation } from './issue-source.js';
import { createGitHubPullRequestSource, type GitHubPullRequestSourceClient } from './pr-source.js';
import { githubReviewObservation } from './review-source.js';

interface GitHubSourceClient extends GitHubPullRequestSourceClient {
  listIssues(
    owner: string,
    repo: string,
    maxResults: number,
  ): Promise<readonly Parameters<typeof issueObservation>[0]['issue'][]>;
  listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    pageSize: number,
  ): Promise<readonly GitHubIssueCommentPayload[]>;
  listReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    pageSize: number,
  ): Promise<readonly GitHubReviewPayload[]>;
  listReviewComments?(
    owner: string,
    repo: string,
    pullNumber: number,
    pageSize: number,
  ): Promise<readonly GitHubIssueCommentPayload[]>;
}

export function createGitHubSource(
  config: GitHubConfig,
  client: GitHubSourceClient,
  adapter?: AdapterId,
): ExternalEventSource {
  let nextPollAt = 0;
  // Draft eventIds are already content fingerprints (see issue-source.ts/pr-source.ts),
  // so the journal itself is idempotent per item. This cache only avoids re-appending
  // (and re-triggering downstream translation) an unchanged item on every poll within
  // a single process lifetime — it's a perf optimization, not a correctness dependency,
  // so it's safe for it to reset on restart.
  const lastEventIds = new Map<string, string>();
  return {
    async poll(signal) {
      if (Date.now() < nextPollAt) return [];
      nextPollAt = Date.now() + config.polling.lookbackMs;
      const perRepository = await Promise.all(
        config.repositories.map(({ owner, repo }) =>
          pollRepository({ client, config, adapter, signal, owner, repo }),
        ),
      );
      return perRepository.flat().filter((draft) => {
        if (draft.eventType !== GitHubEventType.WorkObserved) return true;
        const prior = lastEventIds.get(draft.payload.externalKey);
        lastEventIds.set(draft.payload.externalKey, draft.eventId);
        return prior !== draft.eventId;
      });
    },
  };
}

interface RepositoryPollContext {
  readonly client: GitHubSourceClient;
  readonly config: GitHubConfig;
  readonly adapter: AdapterId | undefined;
  readonly owner: string;
  readonly repo: string;
  readonly repository: string;
}

async function pollRepository(input: {
  readonly client: GitHubSourceClient;
  readonly config: GitHubConfig;
  readonly adapter: AdapterId | undefined;
  readonly signal: Parameters<ExternalEventSource['poll']>[0];
  readonly owner: string;
  readonly repo: string;
}) {
  const { client, config, adapter, signal, owner, repo } = input;
  const context: RepositoryPollContext = {
    client,
    config,
    adapter,
    owner,
    repo,
    repository: `${owner}/${repo}`,
  };
  try {
    const pullRequestPayloads = await client.listPullRequests(
      owner,
      repo,
      config.polling.maxPerRepo,
    );
    const [issues, pullRequests, reviews, reviewComments] = await Promise.all([
      client.listIssues(owner, repo, config.polling.maxPerRepo),
      createGitHubPullRequestSource({
        client: { ...client, listPullRequests: async () => pullRequestPayloads },
        repository: context.repository,
        maxResults: config.polling.maxPerRepo,
        ...(adapter === undefined ? {} : { adapter }),
      }).poll(signal),
      reviewEventsFor(context, pullRequestPayloads),
      reviewCommentEventsFor(context, pullRequestPayloads),
    ]);
    const issueComments = await issueCommentEventsFor(context, issues);
    return [
      ...issues
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) =>
          issueObservation({
            repository: context.repository,
            issue,
            ...(adapter === undefined ? {} : { adapter }),
          }),
        ),
      ...pullRequests,
      ...reviews,
      ...reviewComments,
      ...issueComments,
    ];
  } catch {
    return [];
  }
}

async function reviewCommentEventsFor(
  context: RepositoryPollContext,
  pullRequests: readonly Parameters<typeof githubReviewObservation>[0]['pullRequest'][],
) {
  if (context.client.listReviewComments === undefined) return [];
  const items = await Promise.all(
    pullRequests.map(async (pullRequest) =>
      (
        await context.client.listReviewComments!(
          context.owner,
          context.repo,
          pullRequest.number,
          context.config.polling.commentPageSize,
        )
      ).flatMap((comment) => {
        const event = issueCommentObservation({
          repository: context.repository,
          issue: pullRequest,
          comment,
          ...(context.adapter === undefined ? {} : { adapter: context.adapter }),
        });
        return event === null ? [] : [event];
      }),
    ),
  );
  return items.flat();
}

async function reviewEventsFor(
  context: RepositoryPollContext,
  pullRequestPayloads: readonly Parameters<typeof githubReviewObservation>[0]['pullRequest'][],
) {
  const items = await Promise.all(
    pullRequestPayloads.map(async (pullRequest) => {
      const reviewEvents = await context.client.listReviews(
        context.owner,
        context.repo,
        pullRequest.number,
        context.config.polling.commentPageSize,
      );
      return reviewEvents.flatMap((review) => {
        const event = githubReviewObservation({
          repository: context.repository,
          pullRequest,
          review,
          authorizedReviewers: [],
        });
        return event === null ? [] : [event];
      });
    }),
  );
  return items.flat();
}

async function issueCommentEventsFor(
  context: RepositoryPollContext,
  issues: readonly Parameters<typeof issueObservation>[0]['issue'][],
) {
  const items = await Promise.all(
    issues.map(async (issue) =>
      (
        await context.client.listIssueComments(
          context.owner,
          context.repo,
          issue.number,
          context.config.polling.commentPageSize,
        )
      ).flatMap((comment) => {
        const event = issueCommentObservation({
          repository: context.repository,
          issue,
          comment,
          ...(context.adapter === undefined ? {} : { adapter: context.adapter }),
        });
        return event === null ? [] : [event];
      }),
    ),
  );
  return items.flat();
}
