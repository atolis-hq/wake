import { expect, it } from 'vitest';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import {
  BuiltInResourceCapability,
  resourceKind,
  type ResourceCapability,
  type ResourceKind,
} from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

import {
  activationId,
  activityName,
  createPullRequestMergeActivity,
} from '../../../src/activities/index.js';
import type { workItemId } from '../../../src/work/index.js';
import { TestWorld } from '../../e2e/support/world.js';

// A4: pr.merge's provider-neutral deterministic merge policy (maxFilesChanged,
// blockedPaths), gated on a changed-files capability the provider may or may
// not supply. Also proves §6.6: merge authority never tests ResourceKind.

it('merges when the changed-file count is within the configured cap', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const resource = await setupApprovedPullRequest(world, work.workItemId, {
    changedFiles: ['src/a.ts', 'src/b.ts'],
  });
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      invocation(work.workItemId, resource, {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        maxFilesChanged: 5,
        blockedPaths: [],
      }),
      context(),
    ),
  ).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

it('denies when the changed-file count exceeds the configured cap', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const resource = await setupApprovedPullRequest(world, work.workItemId, {
    changedFiles: ['a.ts', 'b.ts', 'c.ts'],
  });
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      invocation(work.workItemId, resource, {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        maxFilesChanged: 2,
        blockedPaths: [],
      }),
      context(),
    ),
  ).resolves.toEqual({ kind: 'blocked', data: { reason: 'too-many-files-changed' } });
  expect(await world.events('pr.merge-requested')).toHaveLength(0);
});

it('denies when a changed path matches a blocked path', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const resource = await setupApprovedPullRequest(world, work.workItemId, {
    changedFiles: ['src/a.ts', 'secrets/keys.env'],
  });
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      invocation(work.workItemId, resource, {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        blockedPaths: ['secrets/keys.env'],
      }),
      context(),
    ),
  ).resolves.toEqual({ kind: 'blocked', data: { reason: 'blocked-path-changed' } });
  expect(await world.events('pr.merge-requested')).toHaveLength(0);
});

it('allows the merge when blockedPaths is empty and no cap is configured, without requiring evidence', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  // No changed-files capability and no changedFiles observed: the policy is
  // not configured, so no evidence is required.
  const resource = await setupApprovedPullRequest(world, work.workItemId, {});
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      invocation(work.workItemId, resource, {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        blockedPaths: [],
      }),
      context(),
    ),
  ).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
});

it('denies explicitly, never silently allowing, when policy is configured but no changed-file evidence is available', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  // Mergeable and reviewed, but the provider never declared the changed-files
  // capability and no changedFiles were observed.
  const resource = await setupApprovedPullRequest(world, work.workItemId, {});
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      invocation(work.workItemId, resource, {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        maxFilesChanged: 5,
        blockedPaths: [],
      }),
      context(),
    ),
  ).resolves.toEqual({ kind: 'blocked', data: { reason: 'changed-files-unavailable' } });
  expect(await world.events('pr.merge-requested')).toHaveLength(0);
});

it('merges a mergeable resource whose kind is not "pull-request" through the same authority path (§6.6)', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const resource = await setupApprovedPullRequest(
    world,
    work.workItemId,
    {},
    resourceKind('merge-request'),
  );
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      invocation(work.workItemId, resource, {
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        blockedPaths: [],
      }),
      context(),
    ),
  ).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

interface Setup {
  readonly resourceId: ReturnType<typeof resId>;
  readonly kind: ResourceKind;
  readonly capabilities: readonly ResourceCapability[];
}

async function setupApprovedPullRequest(
  world: TestWorld,
  work: ReturnType<typeof workItemId>,
  options: { readonly changedFiles?: readonly string[] },
  kind: ResourceKind = resourceKind('pull-request'),
): Promise<Setup> {
  const resource = resId('1');
  const capabilities: readonly ResourceCapability[] = [
    BuiltInResourceCapability.Reviewable,
    BuiltInResourceCapability.Mergeable,
    BuiltInResourceCapability.Revisioned,
    ...(options.changedFiles === undefined ? [] : [BuiltInResourceCapability.ChangedFiles]),
  ];
  await world.discoverResource({
    resourceId: resource,
    kind,
    externalKey: { adapter: 'test', key: 'pr-1' },
    capabilities,
  });
  await world.resources.correlate(resource, work, 'primary', command(world, 'correlate'));
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: work,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
      ...(options.changedFiles === undefined ? {} : { changedFiles: options.changedFiles }),
    },
    command(world, 'observe'),
  );
  await world.pullRequests.acceptReviewSignal(
    {
      resourceId: resource,
      revision: 'head-a',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'review-1',
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
    },
    command(world, 'approve'),
  );
  return { resourceId: resource, kind, capabilities };
}

function invocation(
  work: ReturnType<typeof workItemId>,
  resource: Setup,
  input: {
    target: 'primary';
    method: 'merge' | 'squash' | 'rebase';
    requireChecks: boolean;
    maxFilesChanged?: number;
    blockedPaths: readonly string[];
  },
) {
  return {
    activationId: activationId('activation-1'),
    activity: activityName('pr.merge'),
    workItemId: work,
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    causationId: 'activation-1',
    input,
    resources: [
      {
        resourceId: resource.resourceId,
        kind: resource.kind,
        externalKey: { adapter: 'test', key: 'pr-1' },
        capabilities: resource.capabilities,
      },
    ],
  };
}

function context() {
  return {
    occurredAt: '2026-07-30T12:10:00.000Z',
    signal: new AbortController().signal,
    async reportExternalExecution() {},
  };
}

function command(world: TestWorld, commandId: string) {
  return {
    commandId,
    correlationId: 'scenario-1' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
}
