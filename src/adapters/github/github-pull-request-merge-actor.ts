import type { PullRequestMergeActor } from '../../core/contracts.js';
import type { MergeMethod } from '../../domain/types.js';
import type { createGitHubClient } from './github-client.js';

type GitHubClient = ReturnType<typeof createGitHubClient>;

function parseGithubPullRequestResourceUri(resourceUri: string): {
  owner: string;
  repo: string;
  pullNumber: number;
} {
  const match = /^github:pr:([^/]+)\/([^#]+)#(\d+)$/.exec(resourceUri);
  if (match === null) {
    throw new Error(`Unsupported GitHub pull request resource URI: ${resourceUri}`);
  }

  return {
    owner: match[1]!,
    repo: match[2]!,
    pullNumber: Number(match[3]),
  };
}

export function createGitHubPullRequestMergeActor(input: {
  client: GitHubClient;
}): PullRequestMergeActor {
  return {
    async listChangedFiles(resourceUri: string): Promise<string[]> {
      const ref = parseGithubPullRequestResourceUri(resourceUri);
      const files = await input.client.listPullRequestFiles(ref.owner, ref.repo, ref.pullNumber);
      return files.map((file) => file.filename);
    },
    async approve(resourceUri: string, body: string): Promise<void> {
      const ref = parseGithubPullRequestResourceUri(resourceUri);
      await input.client.createPullRequestApproval(ref.owner, ref.repo, ref.pullNumber, body);
    },
    async enableAutoMerge(resourceUri: string, mergeMethod: MergeMethod): Promise<void> {
      const ref = parseGithubPullRequestResourceUri(resourceUri);
      const pr = await input.client.getPullRequest(ref.owner, ref.repo, ref.pullNumber);
      await input.client.enablePullRequestAutoMerge(pr.node_id, mergeMethod);
    },
  };
}
