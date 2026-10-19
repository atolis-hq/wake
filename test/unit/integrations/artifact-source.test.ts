import { expect, it } from 'vitest';
import { matchesArtifactSource } from '../../../src/integrations/application/artifact-source.js';

const externalKey = { adapter: 'github', key: 'owner/repo#1' };
const observed = {
  repository: 'owner/repo',
  branch: 'child',
  revision: 'a'.repeat(40),
  base: 'integration',
};
const context = {
  repository: { adapter: 'github', key: 'owner/repo' },
  workspaceBranch: 'child',
  workspaceRevision: 'a'.repeat(40),
  pullRequestBase: 'integration',
};
it('verifies the repository, implementation branch, exact head, and logical PR base independently', () => {
  expect(matchesArtifactSource(externalKey, observed, context)).toBe(true);
  for (const wrong of [
    { repository: 'owner/other' },
    { branch: 'other' },
    { revision: 'b'.repeat(40) },
    { base: 'main' },
  ]) {
    expect(matchesArtifactSource(externalKey, { ...observed, ...wrong }, context)).toBe(false);
  }
  expect(matchesArtifactSource({ ...externalKey, adapter: 'other' }, observed, context)).toBe(
    false,
  );
});
