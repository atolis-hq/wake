import { Octokit } from '@octokit/rest';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({ auth: token });

  return {
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
    async listComments(
      owner: string,
      repo: string,
      issueNumber: number,
      perPage: number,
    ) {
      return octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: perPage,
      });
    },
    async createComment(
      owner: string,
      repo: string,
      issueNumber: number,
      body: string,
    ) {
      return octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
    },
    async setLabels(
      owner: string,
      repo: string,
      issueNumber: number,
      labels: string[],
    ) {
      return octokit.rest.issues.setLabels({
        owner,
        repo,
        issue_number: issueNumber,
        labels,
      });
    },
  };
}
