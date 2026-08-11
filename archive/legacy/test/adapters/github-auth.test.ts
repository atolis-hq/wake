import { describe, expect, it } from 'vitest';

import { resolveGitHubToken } from '../../src/adapters/github/github-auth.js';

describe('github auth', () => {
  it('returns the gh auth token on success', async () => {
    const token = await resolveGitHubToken({
      execFile: async () => ({ stdout: 'ghs_test_token\n', stderr: '' }),
    });

    expect(token).toBe('ghs_test_token');
  });

  it('throws a clear error when gh auth token fails', async () => {
    await expect(
      resolveGitHubToken({
        execFile: async () => {
          throw new Error('gh not authenticated');
        },
      }),
    ).rejects.toThrow('Failed to resolve GitHub token via gh auth token');
  });
});
