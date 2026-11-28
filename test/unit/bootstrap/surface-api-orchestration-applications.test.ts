import { expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { createSurfaceApiApplications } from '../../../src/bootstrap/surface-api-applications.js';
import { type WorkflowInstanceView } from '../../../src/orchestration/index.js';
import { workId } from '../../support/identities.js';

it.each(['open', 'closed', 'cancelled'] as const)(
  'lists retry eligibility for %s work from the canonical projection',
  async (state) => {
    const workflow = {
      workflowInstanceId: 'workflow-canonical' as never,
      workItemId: workId('workflow-canonical'),
      workflowName: 'default' as never,
      orchestrationGroupId: 'group-canonical' as never,
      status: 'blocked',
      blockReason: 'unconfigured outcome failed',
      pendingActivation: {
        activationId: 'activation-1' as never,
        status: 'completed',
        activity: 'agent' as never,
        ordinal: 1,
        input: {},
        execution: undefined,
      },
      lastOutcome: { kind: 'failed' },
      currentStage: 'implement' as never,
      repeatCounts: {},
      retryCounts: {},
      supplementalQueue: [],
      acceptedSignalIds: [],
      operatorRetryCommandIds: [],
      acceptedOutcomes: ['activation-1' as never],
      acceptedChildCompletionIds: [],
      causalRejectionIds: [],
      childCompletionRecorded: false,
    } as WorkflowInstanceView;
    const applications = createSurfaceApiApplications(
      {
        work: { get: async () => ({ state }) },
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

    expect(result.items[0]?.retryEligible).toBe(state === 'open' ? true : undefined);
    expect(result.items).toMatchObject([{ workflowInstanceId: workflow.workflowInstanceId }]);
  },
);
