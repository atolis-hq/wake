import type { AdapterId } from '../../contracts/identifiers.js';
import type { ExternalEventSource } from '../../contracts/intake.js';
import type { GitHubConfig } from '../contracts/config.js';
import type { GitHubReviewPayload } from '../contracts/payloads.js';
import { issueObservation } from './issue-source.js';
import { createGitHubPullRequestSource, type GitHubPullRequestSourceClient } from './pr-source.js';
import { githubReviewObservation } from './review-source.js';

interface GitHubSourceClient extends GitHubPullRequestSourceClient {
  listIssues(
    owner: string,
    repo: string,
    maxResults: number,
  ): Promise<readonly Parameters<typeof issueObservation>[0]['issue'][]>;
  listReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    pageSize: number,
  ): Promise<readonly GitHubReviewPayload[]>;
}

export function createGitHubSource(
  config: GitHubConfig,
  client: GitHubSourceClient,
  adapter?: AdapterId,
): ExternalEventSource {
  return {
    async poll(signal) {
      const perRepository = await Promise.all(
        config.repositories.map(async ({ owner, repo }) => {
          try {
            const repository = `${owner}/${repo}`;
            const pullRequestPayloads = await client.listPullRequests(
              owner,
              repo,
              config.polling.maxPerRepo,
            );
            const [issues, pullRequests, reviews] = await Promise.all([
              client.listIssues(owner, repo, config.polling.maxPerRepo),
              createGitHubPullRequestSource({
                client: { ...client, listPullRequests: async () => pullRequestPayloads },
                repository,
                maxResults: config.polling.maxPerRepo,
                ...(adapter === undefined ? {} : { adapter }),
              }).poll(signal),
              Promise.all(
                pullRequestPayloads.map(async (pullRequest) => {
                  const reviewEvents = await client.listReviews(
                    owner,
                    repo,
                    pullRequest.number,
                    config.polling.commentPageSize,
                  );
                  return reviewEvents.flatMap((review) => {
                    const event = githubReviewObservation({
                      repository,
                      pullRequest,
                      review,
                      authorizedReviewers: [],
                    });
                    return event === null ? [] : [event];
                  });
                }),
              ).then((items) => items.flat()),
            ]);
            return [
              ...issues
                .filter((issue) => issue.pull_request === undefined)
                .map((issue) =>
                  issueObservation({
                    repository,
                    issue,
                    ...(adapter === undefined ? {} : { adapter }),
                  }),
                ),
              ...pullRequests,
              ...reviews,
            ];
          } catch {
            return [];
          }
        }),
      );
      return perRepository.flat();
    },
  };
}
