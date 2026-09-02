import { expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createSurfaceApiApplications } from '../../../src/bootstrap/surface-api-applications.js';
import { type WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it('lists workflows from the canonical orchestration projection value', async () => {
  const workflow = {
    workflowInstanceId: 'workflow-canonical' as never,
    workItemId: workId('workflow-canonical'),
    workflowName: 'default' as never,
    orchestrationGroupId: 'group-canonical' as never,
    status: 'active',
    currentStage: 'implement' as never,
    repeatCounts: {},
    retryCounts: {},
    supplementalQueue: [],
    acceptedSignalIds: [],
    operatorRetryCommandIds: [],
    acceptedOutcomes: [],
    acceptedChildCompletionIds: [],
    causalRejectionIds: [],
    childCompletionRecorded: false,
  } as WorkflowInstanceView;
  const applications = createSurfaceApiApplications(
    {
      projections: {
        list: async () => [{ lastGlobalPosition: 1, value: workflow }],
      },
      journal: {
        readAll: async () => [
          { globalPosition: 1, event: { occurredAt: '2026-09-02T12:00:00.000Z' } },
        ],
      },
    } as unknown as CompositionRoot,
    () => '2026-09-02T12:00:00.000Z',
  );

  const result = await applications.orchestration.list({ limit: 10 });

  expect(result.items).toMatchObject([{ workflowInstanceId: workflow.workflowInstanceId }]);
});
