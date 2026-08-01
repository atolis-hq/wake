import { describe, expect, expectTypeOf, it } from 'vitest';
import { activityName } from '../../src-next/activities/index.js';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { resourceCapability, resourceKind } from '../../src-next/resources/index.js';
import { resId, workId } from '../support/identities.js';

import {
  activationId,
  createPullRequestApproveActivity,
  type PullRequestActivityOutcome,
  type PullRequestApproveInput,
} from '../../src-next/activities/index.js';
import { resourceId } from '../../src-next/resources/index.js';
import { workItemId } from '../../src-next/work/index.js';
import { TestWorld } from '../e2e/support/world.js';

it('creates one provider-neutral approval intent for the current primary PR revision', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'approve', workItemId: workId('1') });
  const resource = resId('1');
  await world.discoverResource({
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'github', key: 'owner/repo#1' },
    capabilities: [resourceCapability('reviewable'), resourceCapability('revisioned')],
  });
  await world.resources.correlate(
    resource,
    work.workItemId,
    'primary',
    command(world, 'correlate'),
  );
  await world.pullRequests.observe(
    {
      resourceId: resource,
      workItemId: work.workItemId,
      state: 'open',
      headRevision: 'head-a',
      baseRevision: 'base-a',
      checks: 'passing',
    },
    command(world, 'observe'),
  );
  const activity = createPullRequestApproveActivity(world.journal, world.pullRequests);

  await expect(
    activity.handler.execute(
      {
        activationId: activationId('activation-1'),
        activity: activityName('pr.approve'),
        workItemId: work.workItemId,
        workflowInstanceId: workflowInstanceId('workflow-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        causationId: 'activation-1',
        input: { target: 'primary', body: 'Reviewed' },
        resources: [
          {
            resourceId: resource,
            kind: resourceKind('pull-request'),
            externalKey: { adapter: 'github', key: 'owner/repo#1' },
            capabilities: [resourceCapability('approvable'), resourceCapability('revisioned')],
          },
        ],
      },
      context(),
    ),
  ).resolves.toEqual({
    kind: 'waiting',
    data: {
      intentEventId: 'activation-1:pr.approve-requested',
      signalKind: signalName('delivery-result'),
    },
  });
  expect(await world.events('pr.approve-requested')).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        activationId: activationId('activation-1'),
        resourceId: resource,
        revision: 'head-a',
        body: 'Reviewed',
        idempotencyKey: 'activation-1:pr.approve-requested',
      }),
    }),
  ]);
});

describe('pr.approve public contract', () => {
  it('defaults target to primary and rejects unknown input and outcome fields', () => {
    const world = new TestWorld();
    const activity = createPullRequestApproveActivity(world.journal, world.pullRequests);

    expect(activity.inputSchema.parse({ body: 'Reviewed' })).toEqual({
      target: 'primary',
      body: 'Reviewed',
    });
    expect(() => activity.inputSchema.parse({ body: 'Reviewed', token: 'secret' })).toThrow();
    expect(() =>
      activity.outcomeSchema.parse({
        kind: 'blocked',
        data: { reason: 'denied', unexpected: true },
      }),
    ).toThrow();
  });

  it('exports the exact shared parsed input and outcome contracts', () => {
    expectTypeOf<PullRequestApproveInput>().toEqualTypeOf<{
      readonly target: 'primary' | { readonly resourceId: ReturnType<typeof resourceId> };
      readonly body?: string;
    }>();
    expectTypeOf<PullRequestActivityOutcome>().toMatchTypeOf<{
      readonly kind: 'waiting' | 'done' | 'blocked' | 'failed';
    }>();
  });
});

it('retries the same activation idempotently without duplicating approval intent', async () => {
  const world = new TestWorld();
  const work = await world.createWork({ objective: 'approve', workItemId: workId('1') });
  await setupApprovablePullRequest(world, work.workItemId);
  const activity = createPullRequestApproveActivity(world.journal, world.pullRequests);
  const request = invocation(work.workItemId);

  const first = await activity.handler.execute(request, context());
  const repeated = await activity.handler.execute(request, context());

  expect(repeated).toEqual(first);
  expect(await world.events('pr.approve-requested')).toHaveLength(1);
});

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

async function setupApprovablePullRequest(world: TestWorld, work: ReturnType<typeof workItemId>) {
  const resource = resId('1');
  await world.discoverResource({
    resourceId: resource,
    kind: resourceKind('pull-request'),
    externalKey: { adapter: 'neutral-test', key: 'pr-1' },
    capabilities: [
      resourceCapability('reviewable'),
      resourceCapability('approvable'),
      resourceCapability('revisioned'),
    ],
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
    },
    command(world, 'observe'),
  );
}

function invocation(work: ReturnType<typeof workItemId>) {
  return {
    activationId: activationId('activation-1'),
    activity: activityName('pr.approve'),
    workItemId: work,
    workflowInstanceId: workflowInstanceId('workflow-1'),
    orchestrationGroupId: orchestrationGroupId('group-1'),
    causationId: 'activation-1',
    input: { target: 'primary' as const, body: 'Reviewed' },
    resources: [
      {
        resourceId: resId('1'),
        kind: resourceKind('pull-request'),
        externalKey: { adapter: 'neutral-test', key: 'pr-1' },
        capabilities: [resourceCapability('approvable'), resourceCapability('revisioned')] as const,
      },
    ],
  };
}
