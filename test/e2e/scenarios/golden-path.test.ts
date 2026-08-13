import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { ExecutionEventType } from '../../../src/execution/index.js';
import { workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { TestWorld } from '../support/world.js';

const scenario = { id: 'E2E-GOLDEN-001' } as const;

it(`${scenario.id} completes work through orchestration and an explicit Run`, async () => {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('implement'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' };
      },
    },
  });
  world.configureWorkflow('default', {
    stages: {
      implement: {
        activity: 'implement',
        with: {},
        execution: { workspace: 'none' },
        on: { done: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  const work = await world.createWork({ objective: 'ship target architecture' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('default'),
  });
  const result = await world.advance(work.workItemId);
  expect(result.kind).toBe('progressed');
  expect((await world.advance(work.workItemId)).kind).toBe('no-work');
  expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
  expect((await world.viewRuns())[0]).toMatchObject({
    status: 'succeeded',
    outcome: { kind: 'done' },
  });
  expect((await world.events()).map((event) => event.eventType)).toEqual([
    'work.item-created',
    'orchestration.primary-claimed',
    'orchestration.instance-started',
    'orchestration.stage-entered',
    'orchestration.activity-requested',
    'orchestration.activity-started',
    ExecutionEventType.ActivationClaimed,
    'execution.run-started',
    'execution.run-lease-claimed',
    'execution.run-succeeded',
    ExecutionEventType.ActivationReleased,
    'orchestration.activity-outcome-accepted',
    'orchestration.instance-completed',
  ]);
  expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'open' });
});
