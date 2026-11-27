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
import { fakeResources, fakeWork } from '../../../support/reconciler-fakes.js';

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
  it.each([false, true])(
    'keeps parent labels through a two-child run (children first: %s)',
    async (childrenFirst) => {
      const parent = workItemId('work-' + ulid('11'));
      const children = [workItemId('work-' + ulid('12')), workItemId('work-' + ulid('13'))];
      const resource = resourceId('resource-' + ulid('11'));
      const owner = correlation({ resourceId: resource, workItemId: parent });
      let active = true;
      let labels: readonly string[] = ['keep-me'];
      let reads = 0;
      let writes = 0;
      let workflows: WorkflowInstanceView[] = [];
      const reconciler = createGitHubWakeLabelReconciler({
        orchestration: { listAll: async () => workflows },
        resources: fakeResources({
          correlationsForWork: (id) => [
            {
              ...owner,
              workItemId: id,
              role:
                id === parent ? ResourceCorrelationRole.Primary : ResourceCorrelationRole.Secondary,
            },
          ],
          correlations: () =>
            active
              ? [
                  owner,
                  ...children.map((id) => ({
                    ...owner,
                    workItemId: id,
                    role: ResourceCorrelationRole.Secondary,
                  })),
                ]
              : [],
          get: () => githubResource({ resourceId: resource, key: 'atolis-hq/wake#550' }),
        }),
        work: fakeWork(() => openWorkItem()),
        getLabels: async () => {
          reads += 1;
          return labels;
        },
        setLabels: async (_owner, _repo, _number, next) => {
          writes += 1;
          labels = next;
        },
      });
      const parentWorkflow = {
        ...openWorkflow({ workItemId: parent, issue: 550 }),
        status: WorkflowStatus.Blocked,
        currentStage: stageName('recover'),
      };
      const watch = {
        ...openWorkflow({ workItemId: parent, issue: 553 }),
        parentWorkflowInstanceId: parentWorkflow.workflowInstanceId,
      };
      for (const status of [
        WorkflowStatus.Active,
        WorkflowStatus.Waiting,
        WorkflowStatus.Blocked,
        WorkflowStatus.Completed,
      ]) {
        const childWorkflows = children.map((id, index) => ({
          ...openWorkflow({ workItemId: id, issue: 551 + index }),
          status,
          workflowName: workflowName('child-impl'),
        }));
        workflows = childrenFirst
          ? [...childWorkflows, parentWorkflow, watch]
          : [parentWorkflow, watch, ...childWorkflows];
        await reconciler.runOnce();
        expect(labels).toEqual([
          'keep-me',
          'wake:status.blocked',
          'wake:stage.recover',
          'wake:workflow.default',
          'wake:watching',
        ]);
      }
      expect(reads).toBe(1);
      expect(writes).toBe(1);
      workflows = workflows.filter((workflow) => workflow.workItemId !== parent);
      await reconciler.runOnce();
      expect(reads).toBe(1);
      active = false;
      workflows = [openWorkflow({ workItemId: parent, issue: 550 })];
      await reconciler.runOnce();
      expect(reads).toBe(1);
      active = true;
      await reconciler.runOnce();
      expect(labels).not.toContain('wake:watching');
      expect(reads).toBe(2);
    },
  );

  it.each([
    ['approved', 'awaiting-approval'],
    ['orchestration.watch-gate-verdict', 'awaiting-approval'],
    ['blocked', 'blocked'],
    ['failed', 'failed'],
    ['delivery-result', 'working'],
    ['orchestration.resource-transition', 'working'],
  ] as const)('labels a wait on %s as %s', async (signalKind, status) => {
    const item = workItemId(`work-${ulid('5')}`);
    const resource = resourceId(`resource-${ulid('5')}`);
    const published: Array<readonly string[]> = [];
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: {
        listAll: async () => [
          {
            ...openWorkflow({ workItemId: item, issue: 550 }),
            status: WorkflowStatus.Waiting,
            waitingFor: { signalKind },
          } as unknown as WorkflowInstanceView,
        ],
      },
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({ resourceId: id, workItemId: item }),
        ],
        correlationsForWork: (id) => [correlation({ resourceId: resource, workItemId: id })],
        get: (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      }),
      work: fakeWork(() => openWorkItem()),
      getLabels: async () => [],
      setLabels: async (_owner, _repo, _number, labels) => {
        published.push(labels);
      },
    });

    await reconciler.runOnce();

    expect(published[0]).toContain(`wake:status.${status}`);
  });

  it('stops loading a closed, non-concluded work item once it is known to be final', async () => {
    const item = workItemId(`work-${ulid('8')}`);
    let loads = 0;
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 551 })] },
      resources: fakeResources({
        correlations: () => [],
        correlationsForWork: () => [],
        get: () => null,
      }),
      work: fakeWork(() => {
        loads += 1;
        return { state: WorkStatus.Closed };
      }),
      getLabels: async () => [],
      setLabels: async () => undefined,
    });

    await reconciler.runOnce();
    await reconciler.runOnce();
    await reconciler.runOnce();

    expect(loads).toBe(1);
  });

  it('uses an in-memory desired-label cache for an unchanged resource', async () => {
    const item = workItemId(`work-${ulid('9')}`);
    const resource = resourceId(`resource-${ulid('9')}`);
    let reads = 0;
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })] },
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({ resourceId: id, workItemId: item }),
        ],
        correlationsForWork: (id) => [correlation({ resourceId: resource, workItemId: id })],
        get: (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      }),
      work: fakeWork(() => openWorkItem()),
      getLabels: async () => {
        reads += 1;
        return ['keep-me', 'wake:stage.implement', 'wake:workflow.default', 'wake:status.working'];
      },
      setLabels: async () => undefined,
    });

    await reconciler.runOnce();
    await reconciler.runOnce();

    expect(reads).toBe(1);
  });

  it('does not retain label-cache entries across reconciler restart', async () => {
    const item = workItemId(`work-${ulid('6')}`);
    const resource = resourceId(`resource-${ulid('6')}`);
    let reads = 0;
    const input = {
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })] },
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({ resourceId: id, workItemId: item }),
        ],
        correlationsForWork: (id: WorkItemId) => [
          correlation({ resourceId: resource, workItemId: id }),
        ],
        get: (id: ReturnType<typeof resourceId>) =>
          githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      }),
      work: fakeWork(() => openWorkItem()),
      getLabels: async () => {
        reads += 1;
        return ['keep-me', 'wake:stage.implement', 'wake:workflow.default', 'wake:status.working'];
      },
      setLabels: async () => undefined,
    };

    await createGitHubWakeLabelReconciler(input).runOnce();
    await createGitHubWakeLabelReconciler(input).runOnce();

    expect(reads).toBe(2);
  });

  it('sends label reads and mutations through the provider request coordinator', async () => {
    const item = workItemId(`work-${ulid('7')}`);
    const resource = resourceId(`resource-${ulid('7')}`);
    let requests = 0;
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })] },
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({ resourceId: id, workItemId: item }),
        ],
        correlationsForWork: (id) => [correlation({ resourceId: resource, workItemId: id })],
        get: (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      }),
      work: fakeWork(() => openWorkItem()),
      getLabels: async () => ['keep-me'],
      setLabels: async () => undefined,
      requests: {
        run: async (operation) => {
          requests += 1;
          return operation();
        },
      },
    });

    await reconciler.runOnce();

    expect(requests).toBe(2);
  });

  it('invalidates the desired-label cache after a failed mutation', async () => {
    const item = workItemId(`work-${ulid('8')}`);
    const resource = resourceId(`resource-${ulid('8')}`);
    let reads = 0;
    let writes = 0;
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })] },
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({ resourceId: id, workItemId: item }),
        ],
        correlationsForWork: (id) => [correlation({ resourceId: resource, workItemId: id })],
        get: (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      }),
      work: fakeWork(() => openWorkItem()),
      getLabels: async () => {
        reads += 1;
        return ['keep-me'];
      },
      setLabels: async () => {
        writes += 1;
        throw new Error('write failed');
      },
      onError: () => undefined,
    });

    await reconciler.runOnce();
    await reconciler.runOnce();

    expect(reads).toBe(2);
    expect(writes).toBe(2);
  });
  it('does not write when GitHub returns an equivalent label set in another order', async () => {
    const item = workItemId(`work-${ulid('0')}`);
    const resource = resourceId(`resource-${ulid('0')}`);
    const setLabelsCalls: number[] = [];
    const reconciler = createGitHubWakeLabelReconciler({
      orchestration: { listAll: async () => [openWorkflow({ workItemId: item, issue: 550 })] },
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({ resourceId: id, workItemId: item }),
        ],
        correlationsForWork: (id) => [correlation({ resourceId: resource, workItemId: id })],
        get: (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
      }),
      work: fakeWork(() => openWorkItem()),
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
      resources: fakeResources({
        correlations: (id: ReturnType<typeof resourceId>) => [
          correlation({
            resourceId: id,
            workItemId: id === failingResource ? failingItem : okItem,
          }),
        ],
        correlationsForWork: (id) => [
          correlation({
            resourceId: id === failingItem ? failingResource : okResource,
            workItemId: id,
          }),
        ],
        get: (id) =>
          githubResource({
            resourceId: id,
            key: id === failingResource ? 'atolis-hq/wake#550' : 'atolis-hq/wake#554',
          }),
      }),
      work: fakeWork(() => openWorkItem()),
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
        resources: fakeResources({
          correlations: (id: ReturnType<typeof resourceId>) => [
            correlation({ resourceId: id, workItemId: item }),
          ],
          correlationsForWork: (id) => [correlation({ resourceId: resource, workItemId: id })],
          get: (id) => githubResource({ resourceId: id, key: 'atolis-hq/wake#550' }),
        }),
        work: fakeWork(() => openWorkItem()),
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
