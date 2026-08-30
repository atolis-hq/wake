import { describe, expect, it } from 'vitest';
import { activityName } from '../../../src/activities/index.js';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
} from '../../../src/orchestration/contracts/identifiers.js';
import { resourceCapability, resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

import { activationId, createPullRequestMergeActivity } from '../../../src/activities/index.js';
import {} from '../../../src/resources/index.js';
import type { workItemId } from '../../../src/work/index.js';
import { TestWorld } from '../../e2e/support/world.js';

describe('pr.merge Activity', () => {
  it('requires a method and returns a delivery wait after one verified merge intent', async () => {
    const world = new TestWorld();
    const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
    const resource = await setupApprovedPullRequest(world, work.workItemId);
    const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

    await expect(
      activity.handler.execute(
        invocation(work.workItemId, { target: 'primary', method: 'squash', requireChecks: true }),
        context(),
      ),
    ).resolves.toEqual({
      kind: 'waiting',
      data: {
        intentEventId: 'activation-1:pr.merge-requested',
        signalKind: signalName('delivery-result'),
      },
    });
    expect(await world.events('pr.merge-requested')).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          eventId: 'activation-1:pr.merge-requested',
          payload: expect.objectContaining({
            activationId: activationId('activation-1'),
            resourceId: resource,
            revision: 'head-a',
            method: 'squash',
            idempotencyKey: 'activation-1:pr.merge-requested',
          }),
        }),
      }),
    ]);
  });

  it.each(['pending', 'failing'] as const)(
    'blocks without a merge intent when checks are %s',
    async (checks) => {
      const world = new TestWorld();
      const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
      await setupApprovedPullRequest(world, work.workItemId, checks);
      const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

      await expect(
        activity.handler.execute(
          invocation(work.workItemId, { target: 'primary', method: 'merge', requireChecks: true }),
          context(),
        ),
      ).resolves.toEqual({ kind: 'blocked', data: { reason: `checks-${checks}` } });
      expect(await world.events('pr.merge-requested')).toHaveLength(0);
      expect(await world.events('pr.merge-denied')).toHaveLength(1);
    },
  );

  it('blocks a stale approval before it creates a delivery intent', async () => {
    const world = new TestWorld();
    const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
    const resource = await setupApprovedPullRequest(world, work.workItemId);
    await world.pullRequests.observe(
      {
        resourceId: resource,
        workItemId: work.workItemId,
        state: 'open',
        headRevision: 'head-b',
        baseRevision: 'base-a',
        checks: 'passing',
      },
      command(world, 'revision-b'),
    );
    const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

    await expect(
      activity.handler.execute(
        invocation(work.workItemId, { target: 'primary', method: 'rebase', requireChecks: true }),
        context(),
      ),
    ).resolves.toEqual({ kind: 'blocked', data: { reason: 'stale-approval' } });
    expect(await world.events('pr.merge-requested')).toHaveLength(0);
  });

  it('rejects an implicit merge method at the public Activity boundary', () => {
    const world = new TestWorld();
    const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);
    expect(() => activity.inputSchema.parse({ requireChecks: true })).toThrow();
  });

  it('defaults to an approved direct merge', () => {
    const world = new TestWorld();
    const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

    expect(
      activity.inputSchema.parse({
        target: 'primary',
        method: 'squash',
        requireChecks: true,
        blockedPaths: [],
      }),
    ).toMatchObject({ requireApproval: true, autoMerge: false });
  });

  it('allows a pending-check auto-merge after the workflow review gate without a native review', async () => {
    const world = new TestWorld();
    const work = await world.createWork({ objective: 'merge', workItemId: workId('1') });
    await setupApprovedPullRequest(world, work.workItemId, 'pending', false);
    const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

    await expect(
      activity.handler.execute(
        invocation(work.workItemId, {
          target: 'primary',
          method: 'squash',
          requireChecks: true,
          requireApproval: false,
          autoMerge: true,
        }),
        context(),
      ),
    ).resolves.toMatchObject({ kind: 'waiting' });
    expect(await world.events('pr.merge-requested')).toMatchObject([
      { event: { payload: { autoMerge: true } } },
    ]);
  });

  it('rejects an unapproved direct merge at the public Activity boundary', () => {
    const world = new TestWorld();
    const activity = createPullRequestMergeActivity(world.journal, world.pullRequests);

    const result = activity.inputSchema.safeParse({
      target: 'primary',
      method: 'squash',
      requireChecks: true,
      requireApproval: false,
      autoMerge: false,
      blockedPaths: [],
    });

    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['requireApproval'] }),
      );
  });
});

async function setupApprovedPullRequest(
  world: TestWorld,
  work: ReturnType<typeof workItemId>,
  checks: 'pending' | 'passing' | 'failing' = 'passing',
  reviewed = true,
) {
  const resource = resId('1');
  await world.discoverResource({
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'github', key: 'owner/repo#1' },
    capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
  });
  await world.resources.correlate(resource, work, 'primary', command(world, 'correlate'));
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: work,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks,
    },
    command(world, 'observe'),
  );
  if (reviewed)
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
  return resource;
}

function invocation(
  work: ReturnType<typeof workItemId>,
  input: {
    target: 'primary';
    method: 'merge' | 'squash' | 'rebase';
    requireChecks: boolean;
    requireApproval?: boolean;
    autoMerge?: boolean;
  },
) {
  return {
    activationId: activationId('activation-1'),
    activity: activityName('pr.merge'),
    workItemId: work,
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    causationId: 'activation-1',
    input: { ...input, blockedPaths: [] },
    resources: [
      {
        resourceId: resId('1'),
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'github', key: 'owner/repo#1' },
        capabilities: [resourceCapability('mergeable'), resourceCapability('revisioned')] as const,
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
