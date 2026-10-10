import { expect, it } from 'vitest';
import { acquireWorkspace } from '../../../src/execution/application/execution-validation.js';
import { FakeWorkspaceProvider, runId } from '../../../src/execution/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

it.each([
  { kind: BuiltInResourceKind.Issue, revision: 'a'.repeat(64), target: undefined },
  { kind: BuiltInResourceKind.PullRequest, revision: 'b'.repeat(40), target: 'b'.repeat(40) },
  { kind: BuiltInResourceKind.PullRequest, revision: '2026-10-10T00:00:00Z', target: undefined },
  { kind: BuiltInResourceKind.Repository, revision: 'refs/heads/main', target: 'refs/heads/main' },
])(
  'resolves Git checkout targets independently of $kind resource versions',
  async ({ kind, revision, target }) => {
    const provider = new FakeWorkspaceProvider();
    await acquireWorkspace(
      runId('run-revision'),
      'read-only',
      workId('revision'),
      [
        {
          resourceId: resId('revision'),
          kind,
          revision,
          externalKey: { adapter: 'github', key: 'owner/repo#1' },
          capabilities: [],
        },
      ],
      provider,
    );
    expect(provider.requests[0]?.checkoutRevision).toBe(target);
    expect(provider.requests[0]?.repositoryResource.revision).toBe(revision);
  },
);

it('uses a correlated PR head instead of the earlier issue observation', async () => {
  const provider = new FakeWorkspaceProvider();
  const common = { externalKey: { adapter: 'github', key: 'owner/repo#1' }, capabilities: [] };
  await acquireWorkspace(
    runId('review'),
    'read-only',
    workId('review'),
    [
      {
        ...common,
        resourceId: resId('issue'),
        kind: BuiltInResourceKind.Issue,
        revision: 'a'.repeat(64),
      },
      {
        ...common,
        resourceId: resId('pr'),
        kind: BuiltInResourceKind.PullRequest,
        revision: 'b'.repeat(40),
      },
    ],
    provider,
  );
  expect(provider.requests[0]?.checkoutRevision).toBe('b'.repeat(40));
  expect(provider.requests[0]?.repositoryResource.resourceId).toBe(resId('pr'));
});
