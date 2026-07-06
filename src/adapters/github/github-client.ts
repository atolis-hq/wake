import { Octokit } from '@octokit/rest';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({ auth: token });

  return {
    async listIssues(owner: string, repo: string, perPage: number) {
      const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: 'open',
        per_page: perPage,
      });

      // GitHub's issues endpoint also returns pull requests (each PR is an
      // "issue" under the hood); Wake should never pick up its own open PRs
      // as fresh work items.
      return issues.filter((issue) => !('pull_request' in issue));
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
      return octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        labels,
      });
    },
  };
}
