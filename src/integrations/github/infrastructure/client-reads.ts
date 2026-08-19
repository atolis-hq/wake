/* eslint-disable max-lines */

import type { Octokit } from '@octokit/rest';
import { PullRequestState } from '../../../activities/index.js';
import type { GitHubIssueQueryFilters } from '../contracts/issue-query.js';
import type { GitHubIssueCommentPayload, GitHubIssuePayload } from '../contracts/payloads.js';
import { GitHubListState } from '../contracts/vocabulary.js';
import type { createEtagCache } from './etag-cache.js';
import { fetchPaginatedWithEtag, fetchWithEtag } from './etag-cache.js';

export function listIssues(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  maxResults: number,
  since?: string,
  filters: GitHubIssueQueryFilters = {},
): Promise<readonly GitHubIssuePayload[]> {
  return fetchPaginatedWithEtag({
    cache,
    key: `issues:${owner}/${repo}:since:${since ?? 'bootstrap'}:assignee:${filters.assignee ?? 'unfiltered'}:labels:${filters.labels ?? 'unfiltered'}`,
    maxResults,
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: GitHubListState.All,
        sort: 'updated',
        direction: 'desc',
        per_page: Math.min(maxResults, 100),
        ...(since === undefined ? {} : { since }),
        ...(filters.assignee === undefined ? {} : { assignee: filters.assignee }),
        ...(filters.labels === undefined ? {} : { labels: filters.labels }),
        ...(headers === undefined ? {} : { headers }),
      }),
  }).then((items) => items.map(normalizeIssue));
}

function normalizeIssue(issue: {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly state_reason?: string | null;
  readonly updated_at: string;
  readonly user?: { readonly login?: string; readonly type?: string } | null;
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly assignees?: readonly ({ readonly login?: string } | null)[] | null;
  readonly pull_request?: Record<string, unknown>;
}): GitHubIssuePayload {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state:
      issue.state === PullRequestState.Closed ? PullRequestState.Closed : PullRequestState.Open,
    ...(issue.state_reason === undefined ? {} : { state_reason: issue.state_reason }),
    updated_at: issue.updated_at,
    ...(issue.user === undefined ? {} : { user: issue.user }),
    ...(issue.labels === undefined ? {} : { labels: issue.labels }),
    ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
    ...(issue.pull_request === undefined ? {} : { pull_request: issue.pull_request }),
  };
}

export async function listPullRequests(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  maxResults: number,
) {
  const pullRequests = await fetchPaginatedWithEtag({
    cache,
    key: `pulls:${owner}/${repo}`,
    maxResults,
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner,
        repo,
        state: GitHubListState.All,
        sort: 'updated',
        direction: 'desc',
        per_page: Math.min(maxResults, 100),
        ...(headers === undefined ? {} : { headers }),
      }),
  });
  return pullRequests.map(normalizePullRequestState);
}

export async function listReviews(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  pullNumber: number,
  options: { readonly pageSize: number; readonly maxResults?: number },
) {
  const reviews = await fetchPaginatedWithEtag({
    cache,
    key: `reviews:${owner}/${repo}#${pullNumber}`,
    ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: boundedCommentPageSize(options),
        ...(headers === undefined ? {} : { headers }),
      }),
  });
  return reviews.map((review) => ({
    id: review.id,
    state: review.state,
    body: review.body,
    commit_id: review.commit_id ?? '',
    submitted_at: review.submitted_at ?? '',
    ...(review.user === undefined ? {} : { user: review.user }),
  }));
}

export async function listReviewComments(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  pullNumber: number,
  options: { readonly pageSize: number; readonly maxResults?: number },
): Promise<readonly GitHubIssueCommentPayload[]> {
  const comments = await fetchPaginatedWithEtag({
    cache,
    key: `review-comments:${owner}/${repo}#${pullNumber}`,
    ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: boundedCommentPageSize(options),
        ...(headers === undefined ? {} : { headers }),
      }),
  });
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    ...(comment.user === undefined ? {} : { user: comment.user }),
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined || comment.line === null ? {} : { line: comment.line }),
    ...(comment.side === undefined ? {} : { side: comment.side }),
  }));
}

export async function listPullRequestFiles(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  pullNumber: number,
  maxResults?: number,
): Promise<readonly string[]> {
  const files = await fetchPaginatedWithEtag({
    cache,
    key: `pull-files:${owner}/${repo}#${pullNumber}`,
    ...(maxResults === undefined ? {} : { maxResults }),
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: boundedPageSize(maxResults),
        ...(headers === undefined ? {} : { headers }),
      }),
  });
  return files.map((file) => file.filename);
}

export function listCheckRunsForRef(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  ref: string,
  maxResults?: number,
) {
  return fetchPaginatedWithEtag({
    cache,
    key: `check-runs:${owner}/${repo}@${ref}`,
    ...(maxResults === undefined ? {} : { maxResults }),
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.checks.listForRef, {
        owner,
        repo,
        ref,
        per_page: boundedPageSize(maxResults),
        ...(headers === undefined ? {} : { headers }),
      }),
  });
}

export function getCombinedStatusForRef(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  ref: string,
  maxResults?: number,
) {
  return fetchPaginatedWithEtag({
    cache,
    key: `combined-status:${owner}/${repo}@${ref}`,
    ...(maxResults === undefined ? {} : { maxResults }),
    pages: (headers) => ({
      async *[Symbol.asyncIterator]() {
        let page = 1;
        let count = 0;
        while (true) {
          const response = await octokit.rest.repos.getCombinedStatusForRef({
            owner,
            repo,
            ref,
            per_page: boundedPageSize(maxResults),
            page,
            ...(headers === undefined ? {} : { headers }),
          });
          const statuses = response.data.statuses;
          count += statuses.length;
          yield { data: statuses, headers: response.headers };
          if (statuses.length < boundedPageSize(maxResults) || count >= response.data.total_count)
            return;
          page += 1;
        }
      },
    }),
  });
}

export function branch(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  name: string,
) {
  return fetchWithEtag({
    cache,
    key: `branch:${owner}/${repo}/${name}`,
    request: async (headers) => {
      const response = await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: name,
        ...(headers === undefined ? {} : { headers }),
      });
      return {
        data: response.data,
        ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }),
      };
    },
  });
}

export function getIssueLabels(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<readonly string[]> {
  return fetchWithEtag({
    cache,
    key: `issue:${owner}/${repo}#${issueNumber}`,
    request: async (headers) => {
      const response = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
        ...(headers === undefined ? {} : { headers }),
      });
      return {
        data: response.data.labels.flatMap((label) =>
          typeof label === 'string' ? [label] : label.name === undefined ? [] : [label.name],
        ),
        ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }),
      };
    },
  });
}

export function getPullRequest(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  return fetchWithEtag({
    cache,
    key: `pull:${owner}/${repo}#${pullNumber}`,
    request: async (headers) => {
      const response = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
        ...(headers === undefined ? {} : { headers }),
      });
      return {
        data: response.data,
        ...(response.headers.etag === undefined ? {} : { etag: response.headers.etag }),
      };
    },
  });
}

function normalizePullRequestState<Value extends { readonly state: string }>(
  pullRequest: Value,
): Omit<Value, 'state'> & {
  readonly state: typeof PullRequestState.Open | typeof PullRequestState.Closed;
} {
  return {
    ...pullRequest,
    state:
      pullRequest.state === PullRequestState.Closed
        ? PullRequestState.Closed
        : PullRequestState.Open,
  };
}

export async function listIssueComments(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  issueNumber: number,
  options: { readonly pageSize: number; readonly since?: string; readonly maxResults?: number },
): Promise<readonly GitHubIssueCommentPayload[]> {
  const comments = await fetchPaginatedWithEtag({
    cache,
    key: `issue-comments:${owner}/${repo}#${issueNumber}:since:${options.since ?? 'bootstrap'}`,
    ...(options.maxResults === undefined ? {} : { maxResults: options.maxResults }),
    pages: (headers) =>
      octokit.paginate.iterator(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: boundedCommentPageSize(options),
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(headers === undefined ? {} : { headers }),
      }),
  });
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    ...(comment.user === undefined ? {} : { user: comment.user }),
  }));
}

function boundedPageSize(maxResults: number | undefined): number {
  return Math.min(maxResults ?? 100, 100);
}

function boundedCommentPageSize(options: {
  readonly pageSize: number;
  readonly maxResults?: number;
}): number {
  return Math.min(options.pageSize, boundedPageSize(options.maxResults));
}
