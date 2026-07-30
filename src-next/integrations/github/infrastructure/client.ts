import { Octokit } from '@octokit/rest';
import { createEtagCache, fetchWithEtag } from './etag-cache.js';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({
    auth: token,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const cache = createEtagCache();
  return {
    async authenticatedLogin(): Promise<string> {
      return (await octokit.rest.users.getAuthenticated()).data.login;
    },
    async listIssues(owner: string, repo: string, maxResults: number) {
      return octokit
        .paginate(octokit.rest.issues.listForRepo, {
          owner,
          repo,
          state: 'all',
          per_page: Math.min(maxResults, 100),
        })
        .then((items) => items.slice(0, maxResults));
    },
    async listPullRequests(owner: string, repo: string, maxResults: number) {
      return octokit
        .paginate(octokit.rest.pulls.list, {
          owner,
          repo,
          state: 'all',
          per_page: Math.min(maxResults, 100),
        })
        .then((items) => items.slice(0, maxResults));
    },
    async branch(owner: string, repo: string, name: string) {
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
    },
  };
}
