import { expect, it } from 'vitest';
import { activationId, activityName } from '../../../src/activities/index.js';
import { createDeliveryIntegration } from '../../../src/bootstrap/delivery-integration.js';
import {
  ExecutionCancellationReason,
  runId,
  RunStatus,
  WorkspaceMode,
  type RunView,
} from '../../../src/execution/index.js';
import { orchestrationGroupId, workflowInstanceId } from '../../../src/orchestration/index.js';
import { TestWorld } from '../../e2e/support/world.js';
import { resId, workId } from '../../support/identities.js';

const request = {
  runId: 'maintain',
  workflowInstanceId: 'parent',
  activationId: 'maintain',
  childWorkItemId: workId('child'),
  resourceId: resId('pr'),
  revision: 'a'.repeat(40),
};
const active: RunView = {
  runId: runId('maintain'),
  activationId: activationId('maintain'),
  activity: activityName('agent'),
  workflowInstanceId: workflowInstanceId('parent'),
  orchestrationGroupId: orchestrationGroupId('parent'),
  attempt: 1,
  status: RunStatus.Started,
  ambiguityAttempts: 0,
  escalated: false,
  startedAt: '2026-10-20T00:00:00.000Z',
  workspace: {
    mode: WorkspaceMode.Branch,
    path: '/leased',
    maintenance: {
      targets: [
        { ...request, outputName: 'change', branch: request.childWorkItemId, path: '/leased' },
      ],
    },
  },
};

function adapter(runs: readonly RunView[]) {
  return createDeliveryIntegration(new TestWorld().pullRequests, async () => runs, {
    verifyTarget: async () => true,
  });
}

it('accepts only the active bound Run with the exact prepared target', async () => {
  await expect(adapter([active]).assertMaintenanceWriter(request)).resolves.toBeUndefined();
});

const { workspace: _workspace, ...unleased } = active;
it.each([
  unleased,
  { ...active, status: RunStatus.Succeeded },
  {
    ...active,
    cancellation: { requestedAt: active.startedAt, reason: ExecutionCancellationReason.Operator },
  },
  { ...active, workflowInstanceId: workflowInstanceId('other') },
  { ...active, activationId: activationId('other') },
])('refuses an unleased, ended, cancelled or misbound reporting Run: %#', async (run) => {
  await expect(adapter([run]).assertMaintenanceWriter(request)).rejects.toMatchObject({
    code: 'not-maintainable',
  });
});

it.each(['maintenance', 'child'] as const)(
  'rejects an ambiguous %s writer discovered only at report time',
  async (kind) => {
    const prior: RunView = {
      ...active,
      runId: runId('prior'),
      status: RunStatus.Ambiguous,
      workspace:
        kind === 'maintenance'
          ? active.workspace!
          : { mode: WorkspaceMode.Branch, path: '/child', branch: request.childWorkItemId },
    };
    await expect(adapter([active, prior]).assertMaintenanceWriter(request)).rejects.toMatchObject({
      code: 'ambiguous-writer',
    });
  },
);
