import { expect, it } from 'vitest';
import {
  presentWorkflowDiagram,
  type WorkflowDiagramOverlay,
} from '../../../src/bootstrap/surface-api-workflow-diagrams.js';
import { RunStatus, type RunView } from '../../../src/execution/index.js';
import {
  type CompiledWorkflow,
  type WorkflowInstanceView,
} from '../../../src/orchestration/index.js';

it('uses one compiled definition card per stage child and overlays repeated activity and watch runs', () => {
  const definition = {
    name: 'dark-factory',
    entry: 'refine',
    commands: {},
    watches: [
      {
        id: 'plan-review',
        workflow: 'review',
        while: { stages: ['refine'], statuses: ['waiting'] },
      },
    ],
    stages: {
      refine: {
        activity: 'refine',
        on: {
          done: {
            id: 'done',
            target: { kind: 'stage', stage: 'implement' },
            reentryTarget: { kind: 'stage', stage: 'refine' },
          },
        },
      },
      implement: {
        activity: 'implement',
        on: {
          done: {
            id: 'done',
            target: { kind: 'complete' },
            reentryTarget: { kind: 'stage', stage: 'implement' },
          },
        },
      },
    },
  } as unknown as CompiledWorkflow;
  const primary = {
    workflowInstanceId: 'workflow-primary',
    currentStage: 'refine',
    status: 'active',
  } as WorkflowInstanceView;
  const child = {
    workflowInstanceId: 'workflow-watch',
    parentWorkflowInstanceId: primary.workflowInstanceId,
    watchId: 'plan-review',
    status: 'active',
  } as WorkflowInstanceView;
  const overlay: WorkflowDiagramOverlay = {
    primary,
    children: [child],
    runs: [
      run('refine-1', primary.workflowInstanceId, 'refine', RunStatus.Succeeded),
      run('refine-2', primary.workflowInstanceId, 'refine', RunStatus.Succeeded),
      run('review-1', child.workflowInstanceId, 'review', RunStatus.Started),
    ],
  };

  const diagram = presentWorkflowDiagram(definition, overlay);

  expect(diagram.stages[0]).toMatchObject({ id: 'refine', runCount: 3, status: 'active' });
  expect(diagram.stages[0]?.children).toMatchObject([
    { id: 'refine:activity', runCount: 2, status: 'completed' },
    { id: 'refine:watch:plan-review', runCount: 1, status: 'active' },
  ]);
  expect(diagram.transitions).toContainEqual({ from: 'refine', to: 'implement', label: 'done' });
});

function run(
  runId: string,
  workflowInstanceId: string,
  stage: string,
  status: typeof RunStatus.Succeeded | typeof RunStatus.Started,
) {
  return {
    runId,
    workflowInstanceId,
    stage,
    activity: stage === 'review' ? 'review' : 'refine',
    status,
    startedAt: '2026-08-22T10:00:00.000Z',
    ...(status === RunStatus.Succeeded ? { finishedAt: '2026-08-22T10:01:00.000Z' } : {}),
  } as RunView;
}
