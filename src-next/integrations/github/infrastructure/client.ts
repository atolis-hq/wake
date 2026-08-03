import { Octokit } from '@octokit/rest';
import { MergeMethod, PullRequestState } from '../../../activities/index.js';
import type { GitHubIssueCommentPayload, GitHubIssuePayload } from '../contracts/payloads.js';
import type { GitHubOutboundAction } from '../contracts/vocabulary.js';
import { GitHubListState } from '../contracts/vocabulary.js';
import { createEtagCache, fetchPaginatedWithEtag, fetchWithEtag } from './etag-cache.js';

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
    getIssueLabels: async (owner: string, repo: string, issueNumber: number) =>
      (
        await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber })
      ).data.labels.flatMap((label) =>
        typeof label === 'string' ? [label] : label.name === undefined ? [] : [label.name],
      ),
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
      octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    listReviews: (owner: string, repo: string, pullNumber: number, pageSize: number) =>
      listReviews(octokit, cache, owner, repo, pullNumber, pageSize),
    listCheckRunsForRef: (owner: string, repo: string, ref: string) =>
      listCheckRunsForRef(octokit, owner, repo, ref),
    getCombinedStatusForRef: (owner: string, repo: string, ref: string) =>
      getCombinedStatusForRef(octokit, owner, repo, ref),
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

function listIssues(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  maxResults: number,
): Promise<readonly GitHubIssuePayload[]> {
  return fetchPaginatedWithEtag({ cache, key: `issues:${owner}/${repo}`, maxResults, pages: (headers) =>
    octokit.paginate.iterator(octokit.rest.issues.listForRepo, { owner, repo, state: GitHubListState.All, per_page: Math.min(maxResults, 100), ...(headers === undefined ? {} : { headers }) }),
  }).then((items) => items.map(normalizeIssue));
}

function normalizeIssue(issue: {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
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
    updated_at: issue.updated_at,
    ...(issue.user === undefined ? {} : { user: issue.user }),
    ...(issue.labels === undefined ? {} : { labels: issue.labels }),
    ...(issue.assignees === undefined ? {} : { assignees: issue.assignees }),
    ...(issue.pull_request === undefined ? {} : { pull_request: issue.pull_request }),
  };
}

async function listPullRequests(octokit: Octokit, cache: ReturnType<typeof createEtagCache>, owner: string, repo: string, maxResults: number) {
  const pullRequests = await fetchPaginatedWithEtag({ cache, key: `pulls:${owner}/${repo}`, maxResults, pages: (headers) =>
    octokit.paginate.iterator(octokit.rest.pulls.list, { owner, repo, state: GitHubListState.All, per_page: Math.min(maxResults, 100), ...(headers === undefined ? {} : { headers }) }),
  });
  return pullRequests.map(normalizePullRequestState);
}

async function listReviews(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  pullNumber: number,
  pageSize: number,
) {
  const reviews = await fetchPaginatedWithEtag({ cache, key: `reviews:${owner}/${repo}#${pullNumber}`, pages: (headers) =>
    octokit.paginate.iterator(octokit.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber, per_page: pageSize, ...(headers === undefined ? {} : { headers }) }),
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

async function listCheckRunsForRef(octokit: Octokit, owner: string, repo: string, ref: string) {
  const checkRuns = [];
  const pages = octokit.paginate.iterator(octokit.rest.checks.listForRef, {
    owner,
    repo,
    ref,
    per_page: 100,
  });
  for await (const page of pages) checkRuns.push(...page.data);
  return checkRuns;
}

async function getCombinedStatusForRef(octokit: Octokit, owner: string, repo: string, ref: string) {
  const statuses = [];
  let page = 1;
  while (true) {
    const response = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
      per_page: 100,
      page,
    });
    statuses.push(...response.data.statuses);
    const totalCount = response.data.total_count;
    if (response.data.statuses.length < 100 || statuses.length >= totalCount) return statuses;
    page += 1;
  }
}

function branch(
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

async function listIssueComments(
  octokit: Octokit,
  cache: ReturnType<typeof createEtagCache>,
  owner: string,
  repo: string,
  issueNumber: number,
  pageSize: number,
): Promise<readonly GitHubIssueCommentPayload[]> {
  const comments = await fetchPaginatedWithEtag({ cache, key: `issue-comments:${owner}/${repo}#${issueNumber}`, pages: (headers) =>
    octokit.paginate.iterator(octokit.rest.issues.listComments, { owner, repo, issue_number: issueNumber, per_page: Math.min(pageSize, 100), ...(headers === undefined ? {} : { headers }) }),
  });
  return comments.map((comment) => ({
    id: comment.id,
    body: comment.body ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    ...(comment.user === undefined ? {} : { user: comment.user }),
  }));
}
