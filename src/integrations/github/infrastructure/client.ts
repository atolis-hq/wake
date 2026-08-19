import { Octokit } from '@octokit/rest';
import { MergeMethod, ProviderPermission, PullRequestState } from '../../../activities/index.js';
import type { GitHubIssueQueryFilters } from '../contracts/issue-query.js';
import { GitHubOutboundAction } from '../contracts/vocabulary.js';
import { createBoundedGitHubFetch } from './bounded-fetch.js';
import {
  branch,
  getCombinedStatusForRef,
  getIssueLabels,
  getPullRequest,
  listCheckRunsForRef,
  listIssueComments,
  listIssues,
  listPullRequestFiles,
  listPullRequests,
  listReviewComments,
  listReviews,
} from './client-reads.js';
import { createEtagCache } from './etag-cache.js';

// Octokit's request-log plugin reports every non-2xx response through this
// callback, including the expected 304 responses produced by conditional ETag
// reads. Keep those cache hits quiet, but retain a small, safe operator signal
// for actual GitHub failures. Octokit may pass error context after the message;
// deliberately ignore it because it can contain request authentication data.
function requestLogStatus(message: string): number | undefined {
  const match = / - (\d{3}) with id /.exec(message);
  return match === null ? undefined : Number(match[1]);
}

export function redactGitHubRequestMessage(message: unknown): string {
  if (typeof message !== 'string') return 'GitHub request failed';
  return message
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '<redacted>')
    .replace(/\b(?:bearer|token|basic)\s+\S+/gi, '<redacted>')
    .replace(/([?&](?:access_token|token|authorization)=)[^&\s]+/gi, '$1<redacted>');
}

function logGitHubRequestFailure(message: unknown): void {
  const text = redactGitHubRequestMessage(message);
  if (requestLogStatus(text) === 304) return;
  process.stderr.write(`GitHub request failed: ${text}\n`);
}

export function createGitHubClient(token: string) {
  const octokit = new Octokit({
    auth: token,
    request: { fetch: createBoundedGitHubFetch() },
    log: { debug() {}, info() {}, warn() {}, error: logGitHubRequestFailure },
  });
  const cache = createEtagCache();
  return {
    ...createGitHubReadClient(octokit, cache),
    authenticatedLogin: async () => (await octokit.rest.users.getAuthenticated()).data.login,
    collaboratorPermission: async (owner: string, repo: string, login: string) => {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: login,
      });
      return providerPermission(data.permission);
    },
    getIssueLabelsFresh: async (owner: string, repo: string, issueNumber: number) => {
      const response = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      return response.data.labels.flatMap((label) =>
        typeof label === 'string' ? [label] : label.name === undefined ? [] : [label.name],
      );
    },
    getIssue: async (owner: string, repo: string, issueNumber: number) =>
      octokit.rest.issues.get({ owner, repo, issue_number: issueNumber }).then(({ data }) => ({
        id: String(data.id),
        state: data.state,
      })),
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
    deliver: (command: GitHubDeliveryCommand) => deliver(octokit, command),
  };
}

function createGitHubReadClient(octokit: Octokit, cache: ReturnType<typeof createEtagCache>) {
  return {
    listIssues: (
      owner: string,
      repo: string,
      maxResults: number,
      since?: string,
      filters?: GitHubIssueQueryFilters,
    ) => listIssues(octokit, cache, owner, repo, maxResults, { since, filters }),
    listPullRequests: (owner: string, repo: string, maxResults: number) =>
      listPullRequests(octokit, cache, owner, repo, maxResults),
    listIssueComments: (
      owner: string,
      repo: string,
      issueNumber: number,
      pageSize: number,
      since?: string,
      maxResults?: number,
    ) =>
      listIssueComments(octokit, cache, owner, repo, issueNumber, {
        pageSize,
        ...(since === undefined ? {} : { since }),
        ...(maxResults === undefined ? {} : { maxResults }),
      }),
    listReviewComments: (
      owner: string,
      repo: string,
      pullNumber: number,
      pageSize: number,
      maxResults?: number,
    ) =>
      listReviewComments(octokit, cache, owner, repo, pullNumber, {
        pageSize,
        ...(maxResults === undefined ? {} : { maxResults }),
      }),
    getIssueLabels: (owner: string, repo: string, issueNumber: number) =>
      getIssueLabels(octokit, cache, owner, repo, issueNumber),
    getPullRequest: (owner: string, repo: string, pullNumber: number) =>
      getPullRequest(octokit, cache, owner, repo, pullNumber),
    listReviews: (
      owner: string,
      repo: string,
      pullNumber: number,
      pageSize: number,
      maxResults?: number,
    ) =>
      listReviews(octokit, cache, owner, repo, pullNumber, {
        pageSize,
        ...(maxResults === undefined ? {} : { maxResults }),
      }),
    listCheckRunsForRef: (owner: string, repo: string, ref: string, maxResults?: number) =>
      listCheckRunsForRef(octokit, cache, owner, repo, ref, maxResults),
    listPullRequestFiles: (owner: string, repo: string, pullNumber: number, maxResults?: number) =>
      listPullRequestFiles(octokit, cache, owner, repo, pullNumber, maxResults),
    getCombinedStatusForRef: (owner: string, repo: string, ref: string, maxResults?: number) =>
      getCombinedStatusForRef(octokit, cache, owner, repo, ref, maxResults),
    branch: (owner: string, repo: string, name: string) =>
      branch(octokit, cache, owner, repo, name),
  };
}

function providerPermission(permission: string): ProviderPermission {
  switch (permission) {
    case ProviderPermission.Read:
    case ProviderPermission.Triage:
    case ProviderPermission.Write:
    case ProviderPermission.Maintain:
    case ProviderPermission.Admin:
      return permission;
    default:
      return ProviderPermission.None;
  }
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
    return directMerge(octokit, command);
  }
  if (command.action === GitHubOutboundAction.EnableAutoMerge) {
    return enableAutoMerge(octokit, command);
  }
  if (command.action === GitHubOutboundAction.Close) {
    if (command.issue_number === undefined)
      throw new Error('GitHub issue completion requires an issue');
    const response = await octokit.rest.issues.update({
      owner: command.owner,
      repo: command.repo,
      issue_number: command.issue_number,
      state: PullRequestState.Closed,
    });
    return String(response.data.id);
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

async function enableAutoMerge(octokit: Octokit, command: GitHubDeliveryCommand): Promise<string> {
  if (command.pull_number === undefined)
    throw new Error('GitHub auto-merge requires a pull request');
  if (command.merge_method === undefined)
    throw new Error('GitHub auto-merge requires an explicit merge method');
  const pullRequest = await octokit.rest.pulls.get({
    owner: command.owner,
    repo: command.repo,
    pull_number: command.pull_number,
  });
  try {
    const result = await octokit.graphql<{
      enablePullRequestAutoMerge: { readonly pullRequest: { readonly id: string } };
    }>(
      `mutation EnableWakeAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
          pullRequest { id }
        }
      }`,
      {
        pullRequestId: pullRequest.data.node_id,
        mergeMethod: graphQlMergeMethod(command.merge_method),
      },
    );
    return result.enablePullRequestAutoMerge.pullRequest.id;
  } catch (error) {
    if (!isAlreadyCleanError(error)) throw error;
    return directMerge(octokit, command);
  }
}

async function directMerge(octokit: Octokit, command: GitHubDeliveryCommand): Promise<string> {
  const response = await octokit.rest.pulls.merge({
    owner: command.owner,
    repo: command.repo,
    pull_number: command.pull_number!,
    ...(command.merge_method === undefined ? {} : { merge_method: command.merge_method }),
  });
  return response.data.sha;
}

function graphQlMergeMethod(method: MergeMethod): 'MERGE' | 'SQUASH' | 'REBASE' {
  return method.toUpperCase() as 'MERGE' | 'SQUASH' | 'REBASE';
}

function isAlreadyCleanError(error: unknown): boolean {
  return error instanceof Error && /is in clean status/i.test(error.message);
}
