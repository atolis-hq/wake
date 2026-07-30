import { z } from 'zod';
import { expect, it } from 'vitest';
import { TestWorld } from '../support/world.js';

it('E2E-GOLDEN-001 completes work through orchestration and an explicit Run', async () => {
  const world = new TestWorld();
  world.registerActivity({
    name: 'implement',
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
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
      },
    },
  });
  const work = await world.createWork({ objective: 'ship target architecture' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: 'default',
  });
  const result = await world.advance(work.workItemId);
  expect(result.kind).toBe('progressed');
  expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
  expect((await world.viewRuns())[0]).toMatchObject({
    status: 'succeeded',
    outcome: { kind: 'done' },
  });
  expect((await world.events()).map((event) => event.eventType)).toEqual([
    'work.item-created',
    'orchestration.instance-started',
    'orchestration.stage-entered',
    'orchestration.activity-requested',
    'orchestration.activity-started',
    'execution.run-started',
    'execution.run-succeeded',
    'orchestration.activity-outcome-accepted',
    'orchestration.instance-completed',
  ]);
  expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'open' });
});
