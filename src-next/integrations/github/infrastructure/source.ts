import type { ExternalEventSource } from '../../contracts/intake.js';
import type { AdapterId } from '../../contracts/identifiers.js';
import type { GitHubConfig } from '../contracts/config.js';
import { issueObservation } from './issue-source.js';
import { createGitHubPullRequestSource, type GitHubPullRequestSourceClient } from './pr-source.js';

interface GitHubSourceClient extends GitHubPullRequestSourceClient {
  listIssues(
    owner: string,
    repo: string,
    maxResults: number,
  ): Promise<readonly Parameters<typeof issueObservation>[0]['issue'][]>;
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
            const [issues, pullRequests] = await Promise.all([
              client.listIssues(owner, repo, config.polling.maxPerRepo),
              createGitHubPullRequestSource({
                client,
                repository,
                maxResults: config.polling.maxPerRepo,
                ...(adapter === undefined ? {} : { adapter }),
              }).poll(signal),
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
            ];
          } catch {
            // One unavailable repository must not prevent other configured repositories polling.
            return [];
          }
        }),
      );
      return perRepository.flat();
    },
  };
}
