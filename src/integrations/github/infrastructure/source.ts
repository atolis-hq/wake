import type { CheckpointStore } from '../../../kernel/index.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { ExternalEventSource } from '../../contracts/intake.js';
import type { GitHubConfig } from '../contracts/config.js';
import { GitHubEventType } from '../contracts/events.js';
import {
  createGitHubAdapterHealthRegistry,
  type GitHubAdapterHealthRegistry,
} from './adapter-health-registry.js';
import {
  issueCommentEventsFor,
  reviewCommentEventsFor,
  reviewEventsFor,
} from './comment-source.js';
import { issueObservation } from './issue-source.js';
import {
  loadWatermark,
  overlapSince,
  reportPartialPollFailure,
  watermarkCheckpoint,
} from './poll-watermark.js';
import { createGitHubPullRequestSource } from './pr-source.js';
import {
  createGitHubRequestCoordinator,
  type GitHubRequestCoordinator,
} from './request-coordinator.js';
import type { GitHubSourceClient, RepositoryPollContext } from './source-contracts.js';

export function createGitHubSource(
  config: GitHubConfig,
  client: GitHubSourceClient,
  adapter?: AdapterId,
  requests: GitHubRequestCoordinator = createGitHubRequestCoordinator({
    maxConcurrent: config.polling.maxConcurrent,
  }),
  state?: {
    readonly checkpoints?: CheckpointStore;
    readonly now?: () => number;
    readonly health?: GitHubAdapterHealthRegistry;
  },
): ExternalEventSource {
  const health = state?.health ?? createGitHubAdapterHealthRegistry(config.repositories);
  // Draft eventIds are already content fingerprints (see issue-source.ts/pr-source.ts),
  // so the journal itself is idempotent per item. This cache only avoids re-appending
  // (and re-triggering downstream translation) an unchanged item on every poll within
  // a single process lifetime — it's a perf optimization, not a correctness dependency,
  // so it's safe for it to reset on restart.
  const lastEventIds = new Map<string, string>();
  const pendingWatermarks = new Map<string, number>();
  const now = state?.now ?? Date.now;
  // In-memory only: an extra real poll after a process restart is harmless,
  // the same tradeoff already made for lastEventIds above.
  let lastPolledAt: number | undefined;
  return {
    async poll(signal) {
      const currentTime = now();
      if (lastPolledAt !== undefined && currentTime - lastPolledAt < config.polling.intervalMs) {
        return [];
      }
      lastPolledAt = currentTime;
      const perRepository = await Promise.all(
        config.repositories.map(async ({ owner, repo }) =>
          pollRepository({
            client: limitGitHubSourceClient(client, requests),
            config,
            adapter,
            signal,
            owner,
            repo,
            watermark: await loadWatermark(state?.checkpoints, adapter, owner, repo),
            now,
            health,
          }),
        ),
      );
      for (const result of perRepository)
        if (result.succeeded) pendingWatermarks.set(result.repository, result.completedAt);
      return perRepository
        .flatMap((result) => result.drafts)
        .filter((draft) => {
          if (draft.eventType !== GitHubEventType.WorkObserved) return true;
          const prior = lastEventIds.get(draft.payload.externalKey);
          lastEventIds.set(draft.payload.externalKey, draft.eventId);
          return prior !== draft.eventId;
        });
    },
    async markPollPersisted() {
      if (state?.checkpoints === undefined) return;
      const checkpoints = state.checkpoints;
      for (const [repository, watermark] of pendingWatermarks) {
        await checkpoints.save(watermarkCheckpoint(adapter, repository), watermark);
        pendingWatermarks.delete(repository);
      }
    },
  };
}

function limitGitHubSourceClient(
  client: GitHubSourceClient,
  requests: GitHubRequestCoordinator,
): GitHubSourceClient {
  return {
    ...client,
    listIssues: (owner, repo, maxResults, since) =>
      requests.run(() => client.listIssues(owner, repo, maxResults, since)),
    listPullRequests: (owner, repo, maxResults) =>
      requests.run(() => client.listPullRequests(owner, repo, maxResults)),
    listCheckRunsForRef: (owner, repo, ref, maxResults) =>
      requests.run(() => client.listCheckRunsForRef(owner, repo, ref, maxResults)),
    getCombinedStatusForRef: (owner, repo, ref, maxResults) =>
      requests.run(() => client.getCombinedStatusForRef(owner, repo, ref, maxResults)),
    listPullRequestFiles: (owner, repo, pullNumber, maxResults) =>
      requests.run(() => client.listPullRequestFiles(owner, repo, pullNumber, maxResults)),
    listIssueComments: (owner, repo, issueNumber, pageSize, since, maxResults) =>
      requests.run(() =>
        client.listIssueComments(owner, repo, issueNumber, pageSize, since, maxResults),
      ),
    listReviews: (owner, repo, pullNumber, pageSize, maxResults) =>
      requests.run(() => client.listReviews(owner, repo, pullNumber, pageSize, maxResults)),
    ...(client.listReviewComments === undefined
      ? {}
      : {
          listReviewComments: (
            owner: string,
            repo: string,
            pullNumber: number,
            pageSize: number,
            maxResults?: number,
          ) =>
            requests.run(() =>
              client.listReviewComments!(owner, repo, pullNumber, pageSize, maxResults),
            ),
        }),
    ...(client.collaboratorPermission === undefined
      ? {}
      : {
          collaboratorPermission: (owner: string, repo: string, login: string) =>
            requests.run(() => client.collaboratorPermission!(owner, repo, login)),
        }),
  };
}

async function pollRepository(input: {
  readonly client: GitHubSourceClient;
  readonly config: GitHubConfig;
  readonly adapter: AdapterId | undefined;
  readonly signal: Parameters<ExternalEventSource['poll']>[0];
  readonly owner: string;
  readonly repo: string;
  readonly watermark: number;
  readonly now: () => number;
  readonly health: GitHubAdapterHealthRegistry;
}) {
  const { client, config, adapter, signal, owner, repo, health } = input;
  const queriedAt = input.now();
  const context: RepositoryPollContext = {
    client,
    config,
    adapter,
    owner,
    repo,
    repository: `${owner}/${repo}`,
  };
  const since = overlapSince(input.watermark, config.polling.lookbackMs);
  const [issuesResult, pullRequestsResult] = await Promise.allSettled([
    client.listIssues(owner, repo, config.polling.maxPerRepo, since),
    client.listPullRequests(owner, repo, config.polling.maxPerRepo),
  ]);
  if (isFulfilled(issuesResult)) health.recordSuccess(context.repository, 'poll');
  else {
    reportPartialPollFailure(context.repository, 'issues');
    health.recordFailure(context.repository, 'poll', issuesResult.reason);
  }
  if (isFulfilled(pullRequestsResult)) health.recordSuccess(context.repository, 'poll');
  else {
    reportPartialPollFailure(context.repository, 'pull requests');
    health.recordFailure(context.repository, 'poll', pullRequestsResult.reason);
  }
  const issues = isFulfilled(issuesResult) ? issuesResult.value : [];
  const pullRequestPayloads = isFulfilled(pullRequestsResult)
    ? pullRequestsResult.value.filter(
        (pullRequest) => since === undefined || pullRequest.updated_at >= since,
      )
    : [];
  const [pullRequests, reviews, reviewComments, issueComments] = await Promise.all([
    createGitHubPullRequestSource({
      client: { ...client, listPullRequests: async () => pullRequestPayloads },
      repository: context.repository,
      maxResults: config.polling.maxPerRepo,
      ...(adapter === undefined ? {} : { adapter }),
    }).poll(signal),
    reviewEventsFor(context, pullRequestPayloads),
    reviewCommentEventsFor(context, pullRequestPayloads),
    issueCommentEventsFor(context, issues, since),
  ]);
  return {
    repository: context.repository,
    completedAt: queriedAt,
    succeeded:
      isFulfilled(issuesResult) &&
      isFulfilled(pullRequestsResult) &&
      reviews.succeeded &&
      reviewComments.succeeded &&
      issueComments.succeeded,
    drafts: [
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
      ...reviews.drafts,
      ...reviewComments.drafts,
      ...issueComments.drafts,
    ],
  };
}

function isFulfilled<Value>(
  result: PromiseSettledResult<Value>,
): result is PromiseFulfilledResult<Value> {
  return 'value' in result;
}
