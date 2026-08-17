import { describe, expect, it } from 'vitest';
import type { CompositionRoot } from '../../../src/bootstrap/composition-root.js';
import {
  withDeliveryResolution,
  withWorkflowContext,
} from '../../../src/bootstrap/surface-api-run-context.js';
import { DeliveryState } from '../../../src/integrations/index.js';
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

const waitingOnDeliveryRun: RunResponse = {
  ...run,
  status: 'succeeded',
  sentinel: 'WAITING',
  outcome: { kind: 'waiting', data: { intentEventId: 'event-42', signalKind: 'delivery-result' } },
};

function rootWithCurrentStage(currentStage: string): CompositionRoot {
  return {
    orchestration: {
      get: async () => ({ workflowName: 'default', currentStage }),
    },
  } as unknown as CompositionRoot;
}

function rootWithDelivery(
  value: { readonly state: string; readonly resolvedAt?: string } | null,
): CompositionRoot {
  return {
    projections: {
      read: async () => (value === null ? null : { value }),
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

describe('withDeliveryResolution', () => {
  it('leaves a run unchanged when its outcome was not waiting on a delivery', async () => {
    const result = await withDeliveryResolution(rootWithDelivery(null), run);

    expect(result.resolution).toBeUndefined();
  });

  it('leaves a run unchanged while the named delivery is still pending', async () => {
    const result = await withDeliveryResolution(
      rootWithDelivery({ state: DeliveryState.Pending }),
      waitingOnDeliveryRun,
    );

    expect(result.resolution).toBeUndefined();
  });

  it('surfaces DONE once the named delivery confirms', async () => {
    const result = await withDeliveryResolution(
      rootWithDelivery({ state: DeliveryState.Confirmed, resolvedAt: '2026-08-17T09:00:00.000Z' }),
      waitingOnDeliveryRun,
    );

    expect(result.resolution).toEqual({ sentinel: 'DONE', resolvedAt: '2026-08-17T09:00:00.000Z' });
  });

  it('surfaces FAILED once the named delivery fails', async () => {
    const result = await withDeliveryResolution(
      rootWithDelivery({ state: DeliveryState.Failed, resolvedAt: '2026-08-17T09:00:00.000Z' }),
      waitingOnDeliveryRun,
    );

    expect(result.resolution).toEqual({
      sentinel: 'FAILED',
      resolvedAt: '2026-08-17T09:00:00.000Z',
    });
  });

  it('surfaces AMBIGUOUS once the named delivery cannot be reconciled', async () => {
    const result = await withDeliveryResolution(
      rootWithDelivery({
        state: DeliveryState.Ambiguous,
        resolvedAt: '2026-08-17T09:00:00.000Z',
      }),
      waitingOnDeliveryRun,
    );

    expect(result.resolution).toEqual({
      sentinel: 'AMBIGUOUS',
      resolvedAt: '2026-08-17T09:00:00.000Z',
    });
  });
});
