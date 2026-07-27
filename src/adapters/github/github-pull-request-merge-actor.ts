import type { PullRequestMergeActor } from '../../core/contracts.js';
import type { MergeMethod } from '../../domain/types.js';
import type { createGitHubClient } from './github-client.js';

type GitHubClient = ReturnType<typeof createGitHubClient>;

// GitHub's enablePullRequestAutoMerge mutation queues a merge pending
// required checks; it refuses with an "already in clean status" error when
// there's nothing left to wait for (checks already passed/skipped). That's
// not a policy rejection — it just means the direct merge endpoint is the
// right call instead of the auto-merge queue.
function isAlreadyCleanError(error: unknown): boolean {
  return error instanceof Error && /is in clean status/i.test(error.message);
}

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
      try {
        await input.client.enablePullRequestAutoMerge(pr.node_id, mergeMethod);
      } catch (error) {
        if (!isAlreadyCleanError(error)) {
          throw error;
        }
        await input.client.mergePullRequest(ref.owner, ref.repo, ref.pullNumber, mergeMethod);
      }
    },
  };
}
