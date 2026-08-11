import { expect, it } from 'vitest';
import { signalName } from '../../../src/orchestration/contracts/identifiers.js';
import { resId } from '../../support/identities.js';

import { resourceStream } from '../../../src/resources/index.js';
import { workItemStream } from '../../../src/work/index.js';
import { TestWorld } from '../support/world.js';
import { executeMerge, setupMergeScenario, type MergeScenario } from './pr-activity-fixtures.js';

const mergeScenario = { id: 'E2E-PR-MERGE-001' } as const;

it(`${mergeScenario.id} emits the configured method and remains waiting for delivery`, async () => {
  const world = new TestWorld();
  const setup = await setupMergeScenario(world, 'safe');
  const workflowId = await executeMerge(world, setup.workItemId);

  expect(await world.events('pr.merge-requested')).toEqual([
    expect.objectContaining({
      source: { kind: 'internal', id: 'activities-pr' },
      payload: expect.objectContaining({
        activationId: expect.any(String),
        resourceId: setup.primaryResourceId,
        revision: 'revision-a',
        method: 'squash',
        idempotencyKey: expect.any(String),
      }),
    }),
  ]);
  const [intent] = await world.events('pr.merge-requested');
  expect(intent?.payload).toMatchObject({ idempotencyKey: intent?.eventId });
  expect((await world.viewWorkflow(workflowId))?.status).toBe('waiting');
  expect(await world.events('pr.merge-denied')).toHaveLength(0);
});

it('accepts one synthetic final delivery outcome for the same waiting activation', async () => {
  const world = new TestWorld();
  const setup = await setupMergeScenario(world, 'safe');
  const workflowId = await executeMerge(world, setup.workItemId);
  const waiting = await world.viewWorkflow(workflowId);
  const activationId = waiting?.pendingActivation?.activationId;
  expect(activationId).toBeDefined();
  expect(waiting).toMatchObject({
    status: 'waiting',
    pendingActivation: { activationId, status: 'waiting' },
    waitingFor: {
      signalKind: signalName('delivery-result'),
      intentEventId: expect.any(String),
    },
    acceptedOutcomes: [],
  });

  await world.acceptOutcome(workflowId, activationId!, {
    kind: 'done',
    data: { deliveryEventId: 'delivery-1' },
  });
  await world.acceptOutcome(workflowId, activationId!, {
    kind: 'done',
    data: { deliveryEventId: 'delivery-1' },
  });

  expect(await world.viewWorkflow(workflowId)).toMatchObject({
    status: 'completed',
    acceptedOutcomes: [activationId],
  });
  expect(await world.events('orchestration.activity-outcome-accepted')).toHaveLength(1);
  expect(await world.events('orchestration.instance-completed')).toHaveLength(1);
});

it('accepts one synthetic final delivery failure for the same waiting activation', async () => {
  const world = new TestWorld();
  const setup = await setupMergeScenario(world, 'safe');
  const workflowId = await executeMerge(world, setup.workItemId);
  const activationId = (await world.viewWorkflow(workflowId))?.pendingActivation?.activationId;

  await world.acceptOutcome(workflowId, activationId!, {
    kind: 'failed',
    data: { reason: 'delivery-failed' },
  });
  await world.acceptOutcome(workflowId, activationId!, {
    kind: 'failed',
    data: { reason: 'delivery-failed' },
  });

  expect(await world.viewWorkflow(workflowId)).toMatchObject({
    status: 'waiting',
    waitingFor: { signalKind: signalName('failed') },
    acceptedOutcomes: [activationId],
  });
  expect(await world.events('orchestration.activity-outcome-accepted')).toHaveLength(1);
});

it('attributes an invalid explicit target denial to the WorkItem', async () => {
  const world = new TestWorld();
  const setup = await setupMergeScenario(world, 'safe');
  await executeMerge(world, setup.workItemId, { resourceId: resId('not-correlated') });

  const [denial] = await world.events('pr.merge-denied');
  expect(denial?.stream).toEqual(workItemStream(setup.workItemId));
  expect(denial?.payload).toEqual(
    expect.objectContaining({
      reason: 'missing-resource',
      target: { resourceId: resId('not-correlated') },
      candidates: [{ resourceId: resId('primary'), revision: 'revision-a' }],
      resourceId: null,
      revision: null,
    }),
  );
  expect(await world.events('pr.merge-requested')).toHaveLength(0);
});

const deniedMergeScenario = { id: 'E2E-PR-MERGE-002' } as const;

it.each([
  ['missing', 'missing-resource'],
  ['capability-missing', 'missing-resource'],
  ['ambiguous', 'ambiguous-resource'],
  ['conflict', 'correlation-conflict'],
  ['closed', 'closed'],
  ['stale', 'stale-approval'],
  ['unauthorized', 'untrusted-actor'],
  ['pending', 'checks-pending'],
  ['failing', 'checks-failing'],
] as const)(
  `${deniedMergeScenario.id} blocks %s through public execution with one auditable denial`,
  async (scenario, reason) => {
    const world = new TestWorld();
    const setup = await setupMergeScenario(world, scenario as MergeScenario);
    const workflowId = await executeMerge(world, setup.workItemId);

    expect((await world.viewRuns())[0]?.outcome?.kind).toBe('blocked');
    expect((await world.viewWorkflow(workflowId))?.status).toBe('waiting');
    expect(await world.events('pr.merge-requested')).toHaveLength(0);
    const denials = await world.events('pr.merge-denied');
    expect(denials).toHaveLength(1);
    const selectionDenied =
      scenario === 'missing' || scenario === 'capability-missing' || scenario === 'ambiguous';
    expect(denials[0]?.stream).toEqual(
      selectionDenied ? workItemStream(setup.workItemId) : resourceStream(setup.primaryResourceId!),
    );
    expect(denials[0]?.payload).toEqual(
      expect.objectContaining(
        selectionDenied
          ? {
              activationId: expect.any(String),
              target: 'primary',
              candidates: selectionCandidates(scenario),
              resourceId: null,
              revision: null,
              reason,
              method: 'squash',
              idempotencyKey: denials[0]?.eventId,
            }
          : {
              activationId: expect.any(String),
              resourceId: setup.primaryResourceId,
              revision: setup.revision,
              reason,
              method: 'squash',
              idempotencyKey: denials[0]?.eventId,
            },
      ),
    );
  },
);

function selectionCandidates(scenario: MergeScenario) {
  if (scenario === 'missing') return [];
  if (scenario === 'capability-missing')
    return [{ resourceId: resId('primary'), revision: 'revision-a' }];
  return [
    { resourceId: resId('primary'), revision: 'revision-a' },
    { resourceId: resId('other-primary'), revision: 'revision-a' },
  ];
}
