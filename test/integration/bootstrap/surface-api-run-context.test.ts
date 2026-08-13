import { describe, expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import { withWorkflowContext } from '../../../src/bootstrap/surface-api-run-context.js';
import type { RunResponse } from '../../../src/surfaces/api/contracts/execution.js';

const run: RunResponse = {
  runId: 'run-1',
  activationId: 'activation-1',
  activity: 'agent',
  workflowInstanceId: 'workflow-1',
  orchestrationGroupId: 'group-1',
  attempt: 1,
  status: 'started',
  active: true,
  startedAt: '2026-08-12T10:00:00.000Z',
  sentinel: 'STARTED',
  totalTokens: 0,
  totalCostUsd: 0,
};

function rootWithCurrentStage(currentStage: string): CompositionRoot {
  return {
    orchestration: {
      get: async () => ({ workflowName: 'default', currentStage }),
    },
  } as unknown as CompositionRoot;
}

describe('withWorkflowContext', () => {
  it('keeps the originating run stage while adding the workflow name', async () => {
    const result = await withWorkflowContext(rootWithCurrentStage('implement'), {
      ...run,
      stage: 'refine',
    });

    expect(result).toMatchObject({ workflowName: 'default', stage: 'refine' });
  });

  it('does not infer a stage for a legacy or supplemental run', async () => {
    const result = await withWorkflowContext(rootWithCurrentStage('implement'), run);

    expect(result).toMatchObject({ workflowName: 'default' });
    expect(result.stage).toBeUndefined();
  });
});
