import { expect, it } from 'vitest';
import { gitHubRepositoryIdentity } from '../../../src/integrations/github/index.js';
import {
  BuiltInResourceKind,
  repositoryCandidate,
  type ResourceView,
} from '../../../src/resources/index.js';

import { resId } from '../../support/identities.js';

const resource = (id: string, kind: ResourceView['kind']): ResourceView => ({
  resourceId: resId(id),
  kind,
  externalKey: { adapter: 'github', key: 'org/repo' },
  capabilities: [],
});
it('selects repository before PR before issue, with stable identity ordering', () => {
  const issue = resource('a', BuiltInResourceKind.Issue);
  const pr = resource('z', BuiltInResourceKind.PullRequest);
  const repository = resource('z-repo', BuiltInResourceKind.Repository);
  const earlier = resource('a-repo', BuiltInResourceKind.Repository);
  expect(repositoryCandidate([])).toBeUndefined();
  expect(repositoryCandidate([issue, pr])).toBe(pr);
  expect(repositoryCandidate([issue, pr, repository])).toBe(repository);
  expect(repositoryCandidate([repository, earlier])).toBe(earlier);
  expect(repositoryCandidate([earlier, repository])).toBe(earlier);
});
it('resolves only valid provider-owned issue and pull request keys', () => {
  expect(gitHubRepositoryIdentity('org/repo#123')).toBe('org/repo');
  for (const key of [
    'org/repo',
    'org/repo#0',
    'org/repo#9007199254740992',
    'org/repo#NaN',
    'org/repo/extra#1',
    'bad key/repo#1',
  ])
    expect(gitHubRepositoryIdentity(key)).toBeUndefined();
});
