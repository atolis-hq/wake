import { Octokit } from '@octokit/rest';

import {
  createEtagCache,
  fetchPaginatedWithEtag,
  fetchSingleWithEtag,
} from './github-etag-cache.js';

// Octokit's built-in request-log plugin routes every non-2xx response
// through `log.error` (console.error by default) before the error reaches
// our code, including the 304s that ETag-based conditional requests are
// *expected* to produce (see github-etag-cache.ts). Without this override,
// normal cache-hit traffic prints as spurious stderr errors. The plugin only
// hands `log.error` a pre-formatted string (`METHOD path - STATUS with id
// ID in Nms`), not the response object, so we extract the actual status
// code from that fixed format rather than substring-matching "304"
// anywhere in the message.
function requestLogStatus(message: string): number | undefined {
  const match = / - (\d{3}) with id /.exec(message);
  return match === null ? undefined : Number(match[1]);
}

export function createGitHubClient(token: string) {
  const octokit = new Octokit({
    auth: token,
    log: {
      debug: () => {},
      info: () => {},
      warn: console.warn.bind(console),
      error: (message: string) => {
        if (requestLogStatus(message) !== 304) {
          console.error(message);
        }
      },
    },
  });
  const etagCache = createEtagCache();

  return {
    async getAuthenticatedLogin(): Promise<string> {
      const { data } = await octokit.rest.users.getAuthenticated();
      return data.login;
    },
    // `maxResults` is a hard cap on issues returned, not just a page size:
    // octokit.paginate otherwise walks every page regardless of page size,
    // which burns GitHub's rate limit (a "fourth budget") on repos with many
    // issues. Stop paginating as soon as the cap is reached.
    async listIssues(owner: string, repo: string, maxResults: number, since?: string) {
      const perPage = Math.min(maxResults, 100);
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `issues:${owner}/${repo}`,
        maxResults,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
            owner,
            repo,
            state: 'all',
            per_page: perPage,
            ...(since === undefined ? {} : { since }),
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async listComments(owner: string, repo: string, issueNumber: number, perPage: number) {
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `issue-comments:${owner}/${repo}#${issueNumber}`,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.issues.listComments, {
            owner,
            repo,
            issue_number: issueNumber,
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async createComment(owner: string, repo: string, issueNumber: number, body: string) {
      return octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
    },
    async setLabels(owner: string, repo: string, issueNumber: number, labels: string[]) {
      return octokit.rest.issues.setLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels,
      });
    },
    async getPullRequest(owner: string, repo: string, pullNumber: number) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return data;
    },
    async getRequiredStatusChecks(owner: string, repo: string, branch: string) {
      const data = await fetchSingleWithEtag({
        cache: etagCache,
        cacheKey: `required-status-checks:${owner}/${repo}@${branch}`,
        request: async (headers) => {
          const response = await octokit.rest.repos.getBranch({
            owner,
            repo,
            branch,
            ...(headers === undefined ? {} : { headers }),
          });
          return { data: response.data, headers: response.headers ?? {} };
        },
      });
      const requiredStatusChecks = data.protection?.required_status_checks;
      return {
        contexts: requiredStatusChecks?.contexts ?? [],
        checks: (requiredStatusChecks?.checks ?? [])
          .map((check) => check.context)
          .filter((context): context is string => typeof context === 'string'),
      };
    },
    async listCheckRunsForRef(owner: string, repo: string, ref: string) {
      const data = await fetchSingleWithEtag({
        cache: etagCache,
        cacheKey: `check-runs:${owner}/${repo}@${ref}`,
        request: async (headers) => {
          const response = await octokit.rest.checks.listForRef({
            owner,
            repo,
            ref,
            per_page: 100,
            ...(headers === undefined ? {} : { headers }),
          });
          return { data: response.data, headers: response.headers ?? {} };
        },
      });
      return data.check_runs;
    },
    async getCombinedStatusForRef(owner: string, repo: string, ref: string) {
      const data = await fetchSingleWithEtag({
        cache: etagCache,
        cacheKey: `combined-status:${owner}/${repo}@${ref}`,
        request: async (headers) => {
          const response = await octokit.rest.repos.getCombinedStatusForRef({
            owner,
            repo,
            ref,
            ...(headers === undefined ? {} : { headers }),
          });
          return { data: response.data, headers: response.headers ?? {} };
        },
      });
      return data.statuses;
    },
    async listPullRequests(owner: string, repo: string, maxResults: number) {
      const perPage = Math.min(maxResults, 100);
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `pulls:${owner}/${repo}`,
        maxResults,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.pulls.list, {
            owner,
            repo,
            state: 'open',
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async listReviews(owner: string, repo: string, pullNumber: number, perPage: number) {
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `pr-reviews:${owner}/${repo}#${pullNumber}`,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async listReviewComments(owner: string, repo: string, pullNumber: number, perPage: number) {
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `pr-review-comments:${owner}/${repo}#${pullNumber}`,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.pulls.listReviewComments, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async replyToReviewComment(
      owner: string,
      repo: string,
      pullNumber: number,
      commentId: number,
      body: string,
    ) {
      return octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        comment_id: commentId,
        body,
      });
    },
  };
}
