import { expect, it } from 'vitest';
import { DelegatedWork } from '../../../src/orchestration/application/delegated-work.js';
import { OrchestrationEventType as Event } from '../../../src/orchestration/index.js';
import { snapshotOf } from '../../support/delivery-snapshot.js';

it.each([
  'matching',
  'wrong-output',
  'wrong-child',
  'other-parent',
  'settled-dependent',
  'no-dependent',
  'running-child',
  'refresh',
  'refresh-named',
  'missing-output',
])('limits settled recovery to a live matching dependency (%s)', async (scenario) => {
  const child = { workItemId: 'upstream', workflowInstanceId: 'upstream-workflow' };
  const original = { cohortId: 'original', parentWorkflowInstanceId: 'parent', children: [child] };
  const dependent = {
    cohortId: 'replacement',
    parentWorkflowInstanceId: scenario === 'other-parent' ? 'other' : 'parent',
    children: [
      {
        prerequisites: [{ output: scenario === 'wrong-output' ? 'note' : 'change' }],
        prerequisiteWorkItemIds: [scenario === 'wrong-child' ? 'another' : 'upstream'],
      },
    ],
  };
  const events = [
    { stream: { id: 'parent' }, event: { eventType: Event.DelegationReserved, payload: original } },
    {
      stream: { id: 'parent' },
      event: { eventType: Event.DelegationFailed, payload: { cohortId: 'original' } },
    },
    ...(scenario === 'no-dependent'
      ? []
      : [
          {
            stream: { id: 'parent' },
            event: { eventType: Event.DelegationReserved, payload: dependent },
          },
        ]),
    ...(scenario === 'settled-dependent'
      ? [
          {
            stream: { id: 'parent' },
            event: { eventType: Event.DelegationJoined, payload: { cohortId: 'replacement' } },
          },
        ]
      : []),
  ];
  const delegated = new DelegatedWork(
    {
      events: async () => events,
      loadRequired: async () => ({ view: { status: 'completed' } }),
    } as never,
    { deliverySnapshot: async () => snapshotOf(() => ({ state: 'open' })) } as never,
    {} as never,
    {} as never,
    {} as never,
    {
      artifacts: {} as never,
      runHasEnded: async () => true,
      childRunsEnded: async () => scenario !== 'running-child',
    },
  );
  const recover = delegated.recoverableChild(
    { workflowInstanceId: 'parent' } as never,
    'upstream',
    scenario.startsWith('refresh') ? 'refresh' : 'review',
    scenario === 'refresh' || scenario === 'missing-output' ? undefined : 'change',
  );
  if (scenario === 'matching')
    await expect(recover).resolves.toEqual({ reservation: original, child });
  else await expect(recover).rejects.toThrow(rejectionReason(scenario));
});

function rejectionReason(scenario: string): string {
  if (scenario.startsWith('refresh')) return 'review recovery only';
  if (scenario === 'missing-output') return 'requires a named output';
  if (scenario === 'running-child') return 'unresolved runs';
  return 'requires a live dependent cohort';
}
