import { orchestrationGroupId } from '../../src-next/orchestration/contracts/identifiers.js';
import { activationId } from '../../src-next/activities/contracts/identifiers.js';
import { resourceKind, resourceCapability } from '../../src-next/resources/index.js';
import { describe, expect, it } from 'vitest';
import { workId, resId } from '../support/identities.js';

import { createPullRequestMergeAuthorityGate } from '../../src-next/activities/index.js';
import { resourceId, resourceStream } from '../../src-next/resources/index.js';
import { workItemStream } from '../../src-next/work/index.js';
import { TestWorld } from '../e2e/support/world.js';

describe('PullRequestService merge authority audit', () => {
  it('appends a durable denial to a correlated Resource lacking a specialist PR view', async () => {
    const world = new TestWorld();
    const work = await world.createWork({ objective: 'merge' });
    const resource = await world.discoverResource({
      resourceId: resId('1'),
      kind: resourceKind('pull-request'),
      externalKey: { adapter: 'github', key: 'owner/repo#1' },
      capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
    });
    await world.resources.correlate(
      resource.resourceId,
      work.workItemId,
      'primary',
      command(world, 'correlate'),
    );

    expect(await world.pullRequests.authorizeMerge(work.workItemId, command(world, 'merge'))).toBe(
      false,
    );
    expect(
      (await world.journal.readStream(resourceStream(resource.resourceId))).at(-1),
    ).toMatchObject({ eventType: 'pr.merge-denied', payload: { reason: 'missing-resource' } });
  });

  it('appends a durable denial to the Work audit stream when no Resource exists', async () => {
    const world = new TestWorld();
    const missingWork = workId('missing');

    expect(await world.pullRequests.authorizeMerge(missingWork, command(world, 'merge'))).toBe(
      false,
    );

    expect((await world.journal.readStream(workItemStream(missingWork))).at(-1)).toMatchObject({
      eventType: 'pr.merge-denied',
      payload: { reason: 'missing-resource' },
    });
  });

  it('reuses the first durable activation denial after mutable authority changes', async () => {
    const world = new TestWorld();
    const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
    const resource = resId('1');
    await world.discoverResource({
      resourceId: resource,
      kind: resourceKind('pull-request'),
      externalKey: { adapter: 'github', key: 'owner/repo#1' },
      capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
    });
    await world.resources.correlate(resource, work.workItemId, 'primary', command(world, 'link'));
    await observe(world, resource, 'pending', 'observe-pending');
    await world.pullRequests.acceptReviewSignal(
      {
        resourceId: resource,
        revision: 'head-a',
        actorId: 'reviewer',
        actorKind: 'human',
        acceptedEventId: 'github-review-1',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
      },
      command(world, 'accept'),
    );
    const gate = createPullRequestMergeAuthorityGate(world.pullRequests);
    const input = {
      activationId: activationId('activation-1'),
      workItemId: work.workItemId,
      orchestrationGroupId: orchestrationGroupId('group-1'),
    };

    expect(await gate.evaluate(input, '2026-07-30T12:10:00Z')).toEqual({
      kind: 'merge-denied',
    });
    await observe(world, resource, 'failing', 'observe-failing');
    expect(await gate.evaluate(input, '2026-07-30T12:20:00Z')).toEqual({
      kind: 'merge-denied',
    });

    const denials = await world.events('pr.merge-denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      occurredAt: '2026-07-30T12:10:00Z',
      payload: { reason: 'checks-pending' },
    });
  });
});

it('reuses a durable authorization after mutable authority becomes failing', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
  const resource = resId('1');
  await world.discoverResource({
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'github', key: 'owner/repo#1' },
    capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
  });
  await world.resources.correlate(resource, work.workItemId, 'primary', command(world, 'link'));
  await observe(world, resource, 'passing', 'observe-passing');
  await world.pullRequests.acceptReviewSignal(
    {
      resourceId: resource,
      revision: 'head-a',
      actorId: 'reviewer',
      actorKind: 'human',
      acceptedEventId: 'github-review-1',
      resourceAuthorId: 'author',
      authorization: { source: 'configured-reviewer', reviewerId: 'reviewer' },
    },
    command(world, 'accept'),
  );
  const gate = createPullRequestMergeAuthorityGate(world.pullRequests);
  const input = {
    activationId: activationId('activation-authorized'),
    workItemId: work.workItemId,
    orchestrationGroupId: orchestrationGroupId('group-1'),
  };

  expect(await gate.evaluate(input, '2026-07-30T12:10:00Z')).toEqual({
    kind: 'merge-authorized',
  });
  await observe(world, resource, 'failing', 'observe-failing');
  expect(await gate.evaluate(input, '2026-07-30T12:20:00Z')).toEqual({
    kind: 'merge-authorized',
  });

  expect(await world.events('pr.merge-authorized')).toEqual([
    expect.objectContaining({
      occurredAt: '2026-07-30T12:10:00Z',
      payload: { revision: 'head-a' },
    }),
  ]);
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

async function observe(
  world: TestWorld,
  resource: ReturnType<typeof resourceId>,
  checks: 'pending' | 'passing' | 'failing',
  commandId: string,
): Promise<void> {
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: workId('1'),
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks,
    },
    command(world, commandId),
  );
}

function command(world: TestWorld, commandId: string) {
  return {
    commandId,
    correlationId: 'correlation-1' as never,
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'system' as const, id: 'test' },
  };
}
