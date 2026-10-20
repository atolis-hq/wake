import { expect, it } from 'vitest';
import { createPullRequestService } from '../../../src/activities/index.js';
import { runId, type RunView } from '../../../src/execution/index.js';
import type { GitHubPullRequestPayload } from '../../../src/integrations/github/contracts/payloads.js';
import { verifiedCheckSubject } from '../../../src/integrations/github/infrastructure/pr-check-subject.js';
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
  const dependencies = {
    resources: world.resources,
    providers: async () => [provider],
    runs: async () => [
      { runId: runId('maintain'), startedAt: '2026-10-20T00:01:00.000Z' } as RunView,
    ],
  };
  const restarted = () =>
    createDeliveryIntegrationVerification({
      ...dependencies,
      pullRequests: createPullRequestService(world.journal, world.work, world.resources),
    });
  let verification = restarted();
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: work.workItemId,
      state: 'open',
      headRevision: 'a'.repeat(40),
      baseRevision: 'c'.repeat(40),
      checks: 'passing',
    },
    context('base-only', '2026-10-20T00:01:30.000Z'),
  );
  const request = {
    ownerWorkItemId: work.workItemId,
    resourceId: resource,
    repositoryResourceId: repository,
    branch: 'child',
    revision: 'a'.repeat(40),
    pullRequestBase: 'main',
    maintenanceRunId: 'maintain',
    maintenanceRecordedAt: '2026-10-20T00:02:15.000Z',
    baseRevision: 'c'.repeat(40),
    requireReview: true,
    requireChecks: true,
  };
  expect(await verification.verifyTarget(request)).toBe(false);
  await world.pullRequests.acceptReviewSignal(
    { ...review, acceptedEventId: 'new' },
    context('new-review', '2026-10-20T00:02:00.000Z'),
  );
  expect(await verification.verifyTarget(request)).toBe(false);
  verification = restarted();
  expect(await verification.verifyTarget(request)).toBe(false);
  const observed = (await world.pullRequests.get(resource))!;
  await world.pullRequests.observe(
    {
      ...observed,
      checkEvidence: {
        headRevision: observed.headRevision,
        baseRevision: observed.baseRevision,
        startedAt: '2026-10-20T00:01:45.000Z',
      },
    },
    context('old-checks-polled', '2026-10-20T00:02:30.000Z'),
  );
  expect(await verification.verifyTarget(request)).toBe(false);
  let testedBase = 'b'.repeat(40);
  let testedRevision = 'old-test-merge';
  const checkClient = {
    listPullRequests: async () => [],
    listPullRequestFiles: async () => [],
    getCommit: async () => ({
      sha: testedRevision,
      parents: [{ sha: testedBase }, { sha: observed.headRevision }],
    }),
    listCheckRunsForRef: async () => [
      {
        head_sha: testedRevision,
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-10-20T00:02:30.000Z',
      },
    ],
    getCombinedStatusForRef: async () => [],
  };
  let providerPr = {
    head: { sha: observed.headRevision },
    base: { sha: observed.baseRevision },
    merge_commit_sha: testedRevision,
  } as GitHubPullRequestPayload;
  const report = async (id: string) => {
    const evidence = await verifiedCheckSubject(checkClient, 'owner', 'repo', providerPr, 100);
    await world.pullRequests.observe(
      { ...observed, checkEvidence: evidence.checkEvidence },
      context(id, '2026-10-20T00:03:00.000Z'),
    );
  };
  // This old-base execution starts after registration, so time alone would accept it.
  await report('late-old-base-checks');
  expect(await verification.verifyTarget(request)).toBe(false);
  verification = restarted();
  expect(await verification.verifyTarget(request)).toBe(false);
  testedBase = observed.baseRevision;
  testedRevision = 'maintained-test-merge';
  providerPr = { ...providerPr, merge_commit_sha: testedRevision };
  await report('verified-current-base-checks');
  expect(await verification.verifyTarget(request)).toBe(true);
  verification = restarted();
  expect(await verification.verifyTarget(request)).toBe(true);
  expect(await verification.verifyTarget({ ...request, pullRequestBase: 'forged' })).toBe(false);
  expect(await verification.verifyTarget({ ...request, ownerWorkItemId: workId('other') })).toBe(
    false,
  );
  expect(await verification.verifyTarget({ ...request, revision: 'f'.repeat(40) })).toBe(false);
});
