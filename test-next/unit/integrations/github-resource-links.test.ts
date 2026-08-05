import { describe, expect, it } from 'vitest';
import { resolveGitHubResourceUrl } from '../../../src-next/integrations/github/application/resource-links.js';

describe('resolveGitHubResourceUrl', () => {
  it('builds an issue/PR URL from an owner/repo#number external key', () => {
    // GitHub redirects /issues/<n> to /pull/<n> automatically when <n> is a PR,
    // so one path form covers both kinds without the resolver needing ResourceKind.
    expect(resolveGitHubResourceUrl({ adapter: 'github', key: 'atolis-hq/wake#412' })).toBe(
      'https://github.com/atolis-hq/wake/issues/412',
    );
  });

  it('returns null for a key it cannot parse', () => {
    expect(resolveGitHubResourceUrl({ adapter: 'github', key: 'not-a-locator' })).toBeNull();
  });
});
