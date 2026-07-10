import { Octokit } from '@octokit/rest';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({ auth: token });

  return {
    async listIssues(owner: string, repo: string, perPage: number) {
      return octokit.paginate(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: 'open',
        per_page: perPage,
      });
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
