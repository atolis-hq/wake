import { describe, expect, it, vi } from 'vitest';

import { createGitHubArtifactVerifier } from '../../src/adapters/github/github-artifact-verifier.js';

describe('createGitHubArtifactVerifier', () => {
  it('verifies a matching-branch PR in the work item\'s own repo', async () => {
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ head: { ref: 'wake/issue-82' } }),
    };
    const verifier = createGitHubArtifactVerifier({ client });

    const result = await verifier.verify(
      { kind: 'pr', url: 'https://github.com/org/repo-a/pull/91' },
      { branch: 'wake/issue-82', repo: 'org/repo-a' },
    );

    expect(result).toEqual({ resourceUri: 'github:pr:org/repo-a#91' });
  });

  it('rejects a matching-branch PR reported in a different repo than the work item\'s own repo', async () => {
    // Branch names are deterministic and low-entropy (wake/issue-<n>), so a
    // PR with the same head branch in an unrelated repo must not pass
    // verification just because the branch happens to match.
    const client = {
      getPullRequest: vi.fn().mockResolvedValue({ head: { ref: 'wake/issue-82' } }),
    };
    const verifier = createGitHubArtifactVerifier({ client });

    const result = await verifier.verify(
      { kind: 'pr', url: 'https://github.com/some-other-org/unrelated-repo/pull/91' },
      { branch: 'wake/issue-82', repo: 'org/repo-a' },
    );

    expect(result).toBeNull();
  });
});
