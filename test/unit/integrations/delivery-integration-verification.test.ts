import { expect, it } from 'vitest';
import { runId, type RunView } from '../../../src/execution/index.js';
import {
  createDeliveryIntegrationVerification,
  type ProviderInstance,
} from '../../../src/integrations/index.js';
import { BuiltInResourceCapability, BuiltInResourceKind } from '../../../src/resources/index.js';
import { TestWorld } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

it('requires provider identity/base verification and a fresh trusted review after a maintenance writer started', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ workItemId: workId('owner'), objective: 'child' });
  const resource = resId('pr'),
    repository = resId('repo');
  for (const [id, kind, key] of [
    [repository, BuiltInResourceKind.Repository, 'org/repo'],
    [resource, BuiltInResourceKind.PullRequest, 'org/repo#1'],
  ] as const)
    await world.discoverResource({
      resourceId: id,
      kind,
      externalKey: { adapter: 'fake', key },
      capabilities: [BuiltInResourceCapability.Revisioned, BuiltInResourceCapability.Reviewable],
    });
  const context = (id: string, occurredAt = '2026-10-20T00:00:00.000Z') => ({
    commandId: id,
    occurredAt,
    correlationId: 'test' as never,
    actor: { kind: 'system' as const, id: 'provider' },
  });
  await world.resources.correlate(resource, work.workItemId, 'primary', context('correlate'));
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: work.workItemId,
      state: 'open',
      headRevision: 'a'.repeat(40),
      baseRevision: 'b'.repeat(40),
      checks: 'passing',
    },
    context('observe'),
  );
  const review = {
    resourceId: resource,
    revision: 'a'.repeat(40),
    actorId: 'reviewer',
    actorKind: 'human' as const,
    acceptedEventId: 'old',
    resourceAuthorId: 'author',
    authorization: { source: 'configured-reviewer' as const, reviewerId: 'reviewer' },
  };
  await world.pullRequests.acceptReviewSignal(review, context('old-review'));
  const provider = {
    adapter: 'fake',
    verifyArtifact: async (
      _kind: unknown,
      externalKey: unknown,
      input: { pullRequestBase: string },
    ) =>
      input.pullRequestBase === 'main'
        ? {
            kind: BuiltInResourceKind.PullRequest,
            externalKey,
            revision: 'a'.repeat(40),
            capabilities: [],
          }
        : 'not-found',
  } as unknown as ProviderInstance;
  const verification = createDeliveryIntegrationVerification({
    resources: world.resources,
    pullRequests: world.pullRequests,
    providers: async () => [provider],
    runs: async () => [
      { runId: runId('maintain'), startedAt: '2026-10-20T00:01:00.000Z' } as RunView,
    ],
  });
  const request = {
    ownerWorkItemId: work.workItemId,
    resourceId: resource,
    repositoryResourceId: repository,
    branch: 'child',
    revision: 'a'.repeat(40),
    pullRequestBase: 'main',
    maintenanceRunId: 'maintain',
    requireReview: true,
    requireChecks: true,
  };
  expect(await verification.verifyTarget(request)).toBe(false);
  await world.pullRequests.acceptReviewSignal(
    { ...review, acceptedEventId: 'new' },
    context('new-review', '2026-10-20T00:02:00.000Z'),
  );
  expect(await verification.verifyTarget(request)).toBe(true);
  expect(await verification.verifyTarget({ ...request, pullRequestBase: 'forged' })).toBe(false);
  expect(await verification.verifyTarget({ ...request, ownerWorkItemId: workId('other') })).toBe(
    false,
  );
  expect(await verification.verifyTarget({ ...request, revision: 'f'.repeat(40) })).toBe(false);
});
