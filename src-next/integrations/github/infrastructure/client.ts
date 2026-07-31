import { PullRequestState } from '../../../activities/index.js';
import { Octokit } from '@octokit/rest';
import { createEtagCache, fetchWithEtag } from './etag-cache.js';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({
    auth: token,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const cache = createEtagCache();
  return {
    authenticatedLogin: async () => (await octokit.rest.users.getAuthenticated()).data.login,
    listIssues: (owner: string, repo: string, maxResults: number) =>
      listIssues(octokit, owner, repo, maxResults),
    listPullRequests: (owner: string, repo: string, maxResults: number) =>
      listPullRequests(octokit, owner, repo, maxResults),
    listCheckRunsForRef: (owner: string, repo: string, ref: string) =>
      listCheckRunsForRef(octokit, owner, repo, ref),
    getCombinedStatusForRef: (owner: string, repo: string, ref: string) =>
      getCombinedStatusForRef(octokit, owner, repo, ref),
    branch: (owner: string, repo: string, name: string) =>
      branch(octokit, cache, owner, repo, name),
  };
}

function listIssues(octokit: Octokit, owner: string, repo: string, maxResults: number) {
  return octokit
    .paginate(octokit.rest.issues.listForRepo, {
      owner,
      repo,
      state: 'all',
      per_page: Math.min(maxResults, 100),
    })
    .then((items) => items.slice(0, maxResults));
}

async function listPullRequests(octokit: Octokit, owner: string, repo: string, maxResults: number) {
  const pullRequests = [];
  const pages = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner,
    repo,
    state: 'all',
    per_page: Math.min(maxResults, 100),
  });
  for await (const page of pages) {
    for (const pullRequest of page.data) {
      pullRequests.push(normalizePullRequestState(pullRequest));
      if (pullRequests.length === maxResults) return pullRequests;
    }
  }
  return pullRequests;
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
