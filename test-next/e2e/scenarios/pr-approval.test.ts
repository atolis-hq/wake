import { expect, it } from 'vitest';
import { resId } from '../../support/identities.js';

import { resourceStream } from '../../../src-next/resources/index.js';
import { workItemStream } from '../../../src-next/work/index.js';
import { TestWorld } from '../support/world.js';
import {
  executeApproval,
  setupApprovalScenario,
  type ApprovalScenario,
} from './pr-activity-fixtures.js';

const scenario = { id: 'E2E-PR-APPROVE-001' } as const;

it(`${scenario.id} emits one exact-revision provider-neutral approval intent`, async () => {
  const world = new TestWorld();
  const setup = await setupApprovalScenario(world, 'safe');
  const workflowId = await executeApproval(world, setup.workItemId);

  expect(await world.events('pr.approve-requested')).toEqual([
    expect.objectContaining({
      eventId: expect.any(String),
      source: { kind: 'internal', id: 'activities-pr' },
      payload: expect.objectContaining({
        activationId: expect.any(String),
        resourceId: setup.primaryResourceId,
        revision: 'revision-a',
        body: 'Reviewed',
        idempotencyKey: expect.any(String),
      }),
    }),
  ]);
  const [intent] = await world.events('pr.approve-requested');
  expect(intent?.payload).toMatchObject({ idempotencyKey: intent?.eventId });
  expect((await world.viewWorkflow(workflowId))?.status).toBe('waiting');
  expect(await world.events('pr.approve-denied')).toHaveLength(0);
});

it.each([
  ['missing', 'missing-resource'],
  ['capability-missing', 'missing-resource'],
  ['ambiguous', 'ambiguous-resource'],
  ['conflict', 'correlation-conflict'],
] as const)(
  'blocks %s approval through public execution with one auditable denial',
  async (scenario, reason) => {
    const world = new TestWorld();
    const setup = await setupApprovalScenario(world, scenario as ApprovalScenario);
    const workflowId = await executeApproval(world, setup.workItemId);

    expect((await world.viewRuns())[0]?.outcome?.kind).toBe('blocked');
    expect((await world.viewWorkflow(workflowId))?.status).toBe('waiting');
    expect(await world.events('pr.approve-requested')).toHaveLength(0);
    const denials = await world.events('pr.approve-denied');
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
              body: 'Reviewed',
              idempotencyKey: denials[0]?.eventId,
            }
          : {
              activationId: expect.any(String),
              resourceId: setup.primaryResourceId,
              revision: setup.revision,
              reason,
              body: 'Reviewed',
              idempotencyKey: denials[0]?.eventId,
            },
      ),
    );
  },
);

function selectionCandidates(scenario: ApprovalScenario) {
  if (scenario === 'missing') return [];
  if (scenario === 'capability-missing')
    return [{ resourceId: resId('primary'), revision: 'revision-a' }];
  return [
    { resourceId: resId('primary'), revision: 'revision-a' },
    { resourceId: resId('other-primary'), revision: 'revision-a' },
  ];
}
