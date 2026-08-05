import { Octokit } from '@octokit/rest';
import { MergeMethod } from '../../../activities/index.js';
import type { GitHubOutboundAction } from '../contracts/vocabulary.js';
import {
  branch,
  getCombinedStatusForRef,
  getIssueLabels,
  getPullRequest,
  listCheckRunsForRef,
  listIssueComments,
  listIssues,
  listPullRequests,
  listReviews,
} from './client-reads.js';
import { createEtagCache } from './etag-cache.js';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({
    auth: token,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const cache = createEtagCache();
  return {
    authenticatedLogin: async () => (await octokit.rest.users.getAuthenticated()).data.login,
    listIssues: (owner: string, repo: string, maxResults: number) =>
      listIssues(octokit, cache, owner, repo, maxResults),
    listPullRequests: (owner: string, repo: string, maxResults: number) =>
      listPullRequests(octokit, cache, owner, repo, maxResults),
    listIssueComments: (owner: string, repo: string, issueNumber: number, pageSize: number) =>
      listIssueComments(octokit, cache, owner, repo, issueNumber, pageSize),
    getIssueLabels: (owner: string, repo: string, issueNumber: number) =>
      getIssueLabels(octokit, cache, owner, repo, issueNumber),
    setIssueLabels: async (
      owner: string,
      repo: string,
      issueNumber: number,
      labels: readonly string[],
    ) => {
      await octokit.rest.issues.setLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels: [...labels],
      });
    },
    getPullRequest: (owner: string, repo: string, pullNumber: number) =>
      getPullRequest(octokit, cache, owner, repo, pullNumber),
    listReviews: (owner: string, repo: string, pullNumber: number, pageSize: number) =>
      listReviews(octokit, cache, owner, repo, pullNumber, pageSize),
    listCheckRunsForRef: (owner: string, repo: string, ref: string) =>
      listCheckRunsForRef(octokit, cache, owner, repo, ref),
    getCombinedStatusForRef: (owner: string, repo: string, ref: string) =>
      getCombinedStatusForRef(octokit, cache, owner, repo, ref),
    branch: (owner: string, repo: string, name: string) =>
      branch(octokit, cache, owner, repo, name),
    deliver: (command: GitHubDeliveryCommand) => deliver(octokit, command),
  };
}

interface GitHubDeliveryCommand {
  readonly owner: string;
  readonly repo: string;
  readonly issue_number?: number;
  readonly pull_number?: number;
  readonly action: GitHubOutboundAction;
  readonly idempotencyKey: string;
  readonly body?: string;
  readonly merge_method?: MergeMethod;
}

async function deliver(octokit: Octokit, command: GitHubDeliveryCommand): Promise<string> {
  const marker = `<!-- wake:delivery:${command.idempotencyKey} -->`;
  if (command.action === 'approve') {
    if (command.pull_number === undefined)
      throw new Error('GitHub approval requires a pull request');
    const response = await octokit.rest.pulls.createReview({
      owner: command.owner,
      repo: command.repo,
      pull_number: command.pull_number,
      event: 'APPROVE',
      body: marker,
    });
    return String(response.data.id);
  }
  if (command.action === MergeMethod.Merge) {
    if (command.pull_number === undefined) throw new Error('GitHub merge requires a pull request');
    const response = await octokit.rest.pulls.merge({
      owner: command.owner,
      repo: command.repo,
      pull_number: command.pull_number,
      ...(command.merge_method === undefined ? {} : { merge_method: command.merge_method }),
    });
    return response.data.sha;
  }
  const issueNumber = command.issue_number ?? command.pull_number;
  if (issueNumber === undefined)
    throw new Error('GitHub comment requires an issue or pull request');
  const response = await octokit.rest.issues.createComment({
    owner: command.owner,
    repo: command.repo,
    issue_number: issueNumber,
    body: `${command.body ?? ''}\n${marker}`,
  });
  return String(response.data.id);
}
