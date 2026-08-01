import { describe, expect, it } from 'vitest';

import {
  formatGitHubResourceKey,
  parseGitHubResourceKey,
} from '../../src-next/integrations/github/contracts/external-key.js';
import { issueObservation } from '../../src-next/integrations/github/infrastructure/issue-source.js';

describe('GitHub external-key grammar', () => {
  it('round-trips a locator through the shared grammar', () => {
    const locator = { owner: 'acme', repo: 'widgets', number: 42 };

    expect(parseGitHubResourceKey(formatGitHubResourceKey(locator))).toEqual(locator);
  });

  it('emits an issue observation key the grammar can parse', () => {
    const observed = issueObservation({
      repository: 'acme/widgets',
      issue: {
        number: 42,
        title: 'Issue',
        body: null,
        state: 'open',
        updated_at: '2026-08-01T00:00:00.000Z',
        user: { login: 'octocat', type: 'User' },
      },
    });

    expect(parseGitHubResourceKey(observed.payload.externalKey)).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
    });
  });

  it('rejects a key that is not owner/repo#number', () => {
    expect(() => parseGitHubResourceKey('acme/widgets/42')).toThrow(/Invalid GitHub resource key/);
  });
});
