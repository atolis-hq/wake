import { describe, expect, it } from 'vitest';
import { createGitHubWakeLabelReconciler } from '../../../../src/integrations/github/application/wake-labels.js';
import {
  stageName,
  workflowInstanceId,
  workflowName,
  WorkflowStatus,
  type WorkflowInstanceView,
} from '../../../../src/orchestration/index.js';
import {
  ResourceCorrelationRole,
  resourceId,
  type ResourceCorrelationView,
  type ResourceView,
} from '../../../../src/resources/index.js';
import {
  workItemId,
  WorkStatus,
  type WorkItemId,
  type WorkItemView,
} from '../../../../src/work/index.js';

const ulid = (suffix: string) => suffix.padStart(26, '0');

function openWorkflow(input: {
  readonly workItemId: WorkItemId;
  readonly issue: number;
}): WorkflowInstanceView {
  return {
    workflowInstanceId: workflowInstanceId(`wf-${input.issue}`),
    workItemId: input.workItemId,
    workflowName: workflowName('default'),
    status: WorkflowStatus.Active,
    currentStage: stageName('implement'),
  } as unknown as WorkflowInstanceView;
}

function correlation(input: {
  readonly resourceId: ReturnType<typeof resourceId>;
  readonly workItemId: WorkItemId;
}): ResourceCorrelationView {
  return {
    resourceId: input.resourceId,
    workItemId: input.workItemId,
    role: ResourceCorrelationRole.Primary,
  } as unknown as ResourceCorrelationView;
}

function githubResource(input: {
  readonly resourceId: ReturnType<typeof resourceId>;
  readonly key: string;
}): ResourceView {
  return {
    resourceId: input.resourceId,
    externalKey: { adapter: 'github', key: input.key },
    capabilities: [],
  } as unknown as ResourceView;
}

function openWorkItem(): WorkItemView {
  return { state: WorkStatus.Open } as unknown as WorkItemView;
}

describe('createGitHubWakeLabelReconciler', () => {
  it('does not write when GitHub returns an equivalent label set in another order', async () => {
    const item = workItemId(`work-${ulid('0')}`);
    const resource = resourceId(`resource-${ulid('0')}`);
    const setLabelsCalls: number[] = [];
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })] },
      resources: {
        correlationsForWork: async (id) => [correlation({ resourceId: resource, workItemId: id })],
        get: async (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      },
      work: { get: async () => openWorkItem() },
      getLabels: async () => [
        'keep-me',
        'wake:stage.implement',
        'wake:workflow.default',
        'wake:status.working',
      ],
      setLabels: async (_owner, _repo, number) => {
        setLabelsCalls.push(number);
      },
    });

    await reconciler.runOnce();

    expect(setLabelsCalls).toEqual([]);
  });

  it('continues reconciling other open work items after one setLabels call fails', async () => {
    const failingItem = workItemId(`work-${ulid('1')}`);
    const okItem = workItemId(`work-${ulid('2')}`);
    const failingResource = resourceId(`resource-${ulid('1')}`);
    const okResource = resourceId(`resource-${ulid('2')}`);

    const setLabelsCalls: number[] = [];
    const errors: { readonly number: number }[] = [];

    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: {
        listAll: async () => [
          openWorkflow({ workItemId: failingItem, issue: 550 }),
          openWorkflow({ workItemId: okItem, issue: 554 }),
        ],
      },
      resources: {
        correlationsForWork: async (id) => [
          correlation({
            resourceId: id === failingItem ? failingResource : okResource,
            workItemId: id,
          }),
        ],
        get: async (id) =>
          githubResource({
            resourceId: id,
            key: id === failingResource ? 'atolis-hq/wake#550' : 'atolis-hq/wake#554',
          }),
      },
      work: {
        get: async () => openWorkItem(),
      },
      getLabels: async () => ['keep-me'],
      setLabels: async (_owner, _repo, number) => {
        setLabelsCalls.push(number);
        if (number === 550) throw new Error('403 rate limit exceeded');
      },
      onError: (failure) => errors.push({ number: failure.number }),
    });

    await expect(reconciler.runOnce()).resolves.toBeUndefined();

    expect(setLabelsCalls.sort()).toEqual([550, 554]);
    expect(errors).toEqual([{ number: 550 }]);
  });

  it('reports the failure via the default stderr handler when no onError is given', async () => {
    const item = workItemId(`work-${ulid('3')}`);
    const resource = resourceId(`resource-${ulid('3')}`);
    const written: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const reconciler = createGitHubWakeLabelReconciler({
        orchestration: {
          listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })],
        },
        resources: {
          correlationsForWork: async (id) => [
            correlation({ resourceId: resource, workItemId: id }),
          ],
          get: async (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
        },
        work: { get: async () => openWorkItem() },
        getLabels: async () => ['keep-me'],
        setLabels: async () => {
          throw new Error('403 rate limit exceeded');
        },
      });

      await reconciler.runOnce();
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(written.join('')).toContain('atolis-hq/wake#550');
    expect(written.join('')).toContain('403 rate limit exceeded');
  });
});
