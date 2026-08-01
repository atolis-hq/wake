import { describe, expect, it } from 'vitest';
import { resId } from '../support/identities.js';

import { translateGitHubReviewCommand } from '../../src-next/integrations/github/index.js';
import {} from '../../src-next/resources/index.js';

const base = {
  resourceId: resId('github-owner-repo-1'),
  revision: 'abc123',
  actorId: 'reviewer',
  actorKind: 'human' as const,
  resourceAuthorId: 'author',
  authorization: { source: 'configured-reviewer' as const, reviewerId: 'reviewer' },
  providerEventId: 'event-1',
};

describe('GitHub review command translator', () => {
  it.each([
    ['/accepted', 'accepted'],
    ['  /changes  ', 'changes-requested'],
  ] as const)('translates exact GitHub command %s to %s', (body, kind) => {
    expect(translateGitHubReviewCommand({ ...base, body })).toEqual({ ...base, kind });
  });

  it.each([
    'Please /accepted',
    '/accepted thanks',
    '/accepted\n/changes',
    '/approve',
    '/ACCEPTED',
    '',
  ])('ignores unsupported or non-exact GitHub syntax %j', (body) => {
    expect(translateGitHubReviewCommand({ ...base, body })).toBeNull();
  });
});
