import { expect, it } from 'vitest';
import { activityName } from '../../src-next/activities/index.js';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { resourceCapability, resourceKind } from '../../src-next/resources/index.js';
import { resId, workId } from '../support/identities.js';

import { activationId, createPullRequestMergeActivity } from '../../src-next/activities/index.js';
import { type ResourceView } from '../../src-next/resources/index.js';
import type { workItemId } from '../../src-next/work/index.js';
import { TestWorld } from '../e2e/support/world.js';

it('keeps an activation denied when authority becomes allowed before retry', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(invocation(work.workItemId, []), executionContext()),
  ).resolves.toEqual({ kind: 'blocked', data: { reason: 'missing-resource' } });

  const resource = await setupApprovedPullRequest(world, work.workItemId);
  await expect(
    activity.handler.execute(invocation(work.workItemId, [resource]), executionContext()),
  ).resolves.toEqual({ kind: 'blocked', data: { reason: 'missing-resource' } });
  expect(await world.events('pr.merge-denied')).toHaveLength(1);
  expect(await world.events('pr.merge-requested')).toHaveLength(0);
});

it('keeps an activation requested when authority becomes denied before retry', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const resource = await setupApprovedPullRequest(world, work.workItemId);
  const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(invocation(work.workItemId, [resource]), executionContext()),
  ).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  await world.pullRequests.observe(
    {
      resourceId: resource.resourceId,
      workItemId: work.workItemId,
      state: 'closed',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    },
    command(world, 'close'),
  );

  await expect(
    activity.handler.execute(invocation(work.workItemId, [resource]), executionContext()),
  ).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.merge-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  expect(await world.events('pr.merge-requested')).toHaveLength(1);
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

async function setupApprovedPullRequest(
  world: TestWorld,
  work: ReturnType<typeof workItemId>,
): Promise<ResourceView> {
  const resource = await world.discoverResource({
    resourceId: resId('1'),
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'neutral-test', key: 'pr-1' },
    capabilities: [
      resourceCapability('reviewable'),
      resourceCapability('mergeable'),
      resourceCapability('revisioned'),
    ],
  });
  await world.resources.correlate(
    resource.resourceId,
    work,
    'primary',
    command(world, 'correlate'),
  );
  await world.pullRequests.observe(
    {
      resourceId: resource.resourceId,
      workItemId: work,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    },
    command(world, 'observe'),
  );
  await world.pullRequests.acceptReviewSignal(
    {
      resourceId: resource.resourceId,
      revision: 'head-a',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'review-1',
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
    },
    command(world, 'approve'),
  );
  return resource;
}

function invocation(work: ReturnType<typeof workItemId>, resources: readonly ResourceView[]) {
  return {
    activationId: activationId('activation-1'),
    activity: activityName('pr.merge'),
    workItemId: work,
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    causationId: 'activation-1',
    input: {
      target: 'primary' as const,
      method: 'merge' as const,
      requireChecks: true,
      blockedPaths: [],
    },
    resources,
  };
}

function executionContext() {
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
