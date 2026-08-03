import type { AdapterId } from '../../contracts/identifiers.js';
import type { ExternalEventSource } from '../../contracts/intake.js';
import type { GitHubConfig } from '../contracts/config.js';
import { GitHubEventType } from '../contracts/events.js';
import { isGitHubWakeMarker } from '../contracts/vocabulary.js';
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
}

export function createGitHubSource(
  config: GitHubConfig,
  client: GitHubSourceClient,
  adapter?: AdapterId,
): ExternalEventSource {
  let nextPollAt = 0;
  const workFingerprints = new Map<string, string>();
  return {
    async poll(signal) {
      if (Date.now() < nextPollAt) return [];
      nextPollAt = Date.now() + config.polling.lookbackMs;
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
            const issueComments = (
              await Promise.all(
                issues
                  .filter((issue) => issue.pull_request === undefined)
                  .map(async (issue) =>
                    (await client.listIssueComments(owner, repo, issue.number, config.polling.commentPageSize)).flatMap(
                      (comment) => {
                        const event = issueCommentObservation({
                          repository,
                          issue,
                          comment,
                          ...(adapter === undefined ? {} : { adapter }),
                        });
                        return event === null ? [] : [event];
                      },
                    ),
                  ),
              )
            ).flat();
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
              ...issueComments,
            ];
          } catch {
            return [];
          }
        }),
      );
      return perRepository.flat().filter((draft) => {
        if (draft.eventType !== GitHubEventType.WorkObserved) return true;
        const fingerprint = workFingerprint(draft.payload);
        const prior = workFingerprints.get(draft.payload.externalKey);
        workFingerprints.set(draft.payload.externalKey, fingerprint);
        return prior !== fingerprint;
      });
    },
  };
}

function workFingerprint(payload: Extract<ReturnType<typeof issueObservation>['payload'], { readonly externalKey: string }>) {
  return JSON.stringify({
    kind: payload.kind,
    externalKey: payload.externalKey,
    title: payload.title,
    body: payload.body,
    state: payload.state,
    actor: payload.actor,
    labels: (payload.labels ?? []).filter((label) => !isGitHubWakeMarker(label)).sort(),
    assignees: [...(payload.assignees ?? [])].sort(),
  });
}
