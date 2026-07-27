import { describe, expect, it, vi } from 'vitest';

import { createGitHubPullRequestMergeActor } from '../../src/adapters/github/github-pull-request-merge-actor.js';
import type { createGitHubClient } from '../../src/adapters/github/github-client.js';

type GitHubClient = ReturnType<typeof createGitHubClient>;

function fakeClient(overrides: Partial<GitHubClient>): GitHubClient {
  return overrides as GitHubClient;
}

describe('createGitHubPullRequestMergeActor', () => {
  it('enables auto-merge with the configured merge method', async () => {
    const client = fakeClient({
      getPullRequest: vi.fn().mockResolvedValue({ node_id: 'PR_node123' }),
      enablePullRequestAutoMerge: vi.fn().mockResolvedValue(undefined),
      mergePullRequest: vi.fn(),
    });
    const actor = createGitHubPullRequestMergeActor({ client });

    await actor.enableAutoMerge('github:pr:org/repo#42', 'SQUASH');

    expect(client.enablePullRequestAutoMerge).toHaveBeenCalledWith('PR_node123', 'SQUASH');
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });

  it('falls back to a direct merge when the PR is already clean (nothing left to wait for)', async () => {
    const client = fakeClient({
      getPullRequest: vi.fn().mockResolvedValue({ node_id: 'PR_node123' }),
      enablePullRequestAutoMerge: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Request failed due to following response errors:\n - Pull request Pull request is in clean status',
          ),
        ),
      mergePullRequest: vi.fn().mockResolvedValue(undefined),
    });
    const actor = createGitHubPullRequestMergeActor({ client });

    await actor.enableAutoMerge('github:pr:org/repo#42', 'SQUASH');

    expect(client.mergePullRequest).toHaveBeenCalledWith('org', 'repo', 42, 'SQUASH');
  });

  it('propagates any other auto-merge failure instead of silently falling back to a direct merge', async () => {
    const client = fakeClient({
      getPullRequest: vi.fn().mockResolvedValue({ node_id: 'PR_node123' }),
      enablePullRequestAutoMerge: vi
        .fn()
        .mockRejectedValue(
          new Error('Merge method merge commits are not allowed on this repository'),
        ),
      mergePullRequest: vi.fn(),
    });
    const actor = createGitHubPullRequestMergeActor({ client });

    await expect(actor.enableAutoMerge('github:pr:org/repo#42', 'MERGE')).rejects.toThrow(
      'Merge method merge commits are not allowed',
    );
    expect(client.mergePullRequest).not.toHaveBeenCalled();
  });
});
