import { describe, expect, it } from 'vitest';
import { gitHubConfigSchema } from '../../../src/integrations/github/contracts/config.js';
import { resolveGitHubCliToken } from '../../../src/integrations/github/infrastructure/gh-auth.js';

describe('GitHub CLI authentication', () => {
  it('uses the trimmed token reported by gh auth token', () => {
    expect(resolveGitHubCliToken(() => 'gho_authenticated\n')).toBe('gho_authenticated');
  });

  it('explains how to authenticate when gh auth token fails', () => {
    expect(() =>
      resolveGitHubCliToken(() => {
        throw new Error('not logged in');
      }),
    ).toThrow('gh auth login');
  });

  it('accepts a GitHub integration configuration without a stored token', () => {
    expect(
      gitHubConfigSchema.parse({
        enabled: true,
        repositories: [{ owner: 'atolis-hq', repo: 'wake-test' }],
      }).token,
    ).toBeUndefined();
  });
});
