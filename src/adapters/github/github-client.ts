import { Octokit } from '@octokit/rest';

import { createEtagCache, fetchSingleWithEtag } from './github-etag-cache.js';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({ auth: token });
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
      const results: Awaited<ReturnType<typeof octokit.rest.issues.listForRepo>>['data'] = [];

      for await (const { data } of octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: 'all',
        per_page: perPage,
        ...(since === undefined ? {} : { since }),
      })) {
        results.push(...data);
        if (results.length >= maxResults) {
          break;
        }
      }

      return results.slice(0, maxResults);
    },
    async listComments(owner: string, repo: string, issueNumber: number, perPage: number) {
      return octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: perPage,
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
      const results: Awaited<ReturnType<typeof octokit.rest.pulls.list>>['data'] = [];

      for await (const { data } of octokit.paginate.iterator(octokit.rest.pulls.list, {
        owner,
        repo,
        state: 'open',
        per_page: perPage,
      })) {
        results.push(...data);
        if (results.length >= maxResults) {
          break;
        }
      }

      return results.slice(0, maxResults);
    },
    async listReviews(owner: string, repo: string, pullNumber: number, perPage: number) {
      return octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
      });
    },
    async listReviewComments(owner: string, repo: string, pullNumber: number, perPage: number) {
      return octokit.paginate(octokit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
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
