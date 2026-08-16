import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-CONTROL-004',
    title: 'a blocked terminal Run does not starve independently ready work on a later tick',
    given: ['one workflow whose runner failure blocks it and a second ready workflow'],
    when: ['the control plane advances again after surfacing the terminal failure'],
    then: ['the original workflow remains blocked while the ready workflow advances'],
  },
  async () => {
    const world = new TestWorld();
    let failedAttempts = 0;
    world.registerActivity({
      name: activityName('fails-once'),
      inputSchema: z.object({}).strict(),
      outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
      outcomeKinds: ['done'],
      resources: [],
      executionKind: 'deterministic',
      handler: {
        async execute() {
          failedAttempts += 1;
          if (failedAttempts === 1) throw new Error('runner exited 1');
          return { kind: 'done' };
        },
      },
    });
    world.registerActivity({
      name: activityName('succeeds'),
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
    world.configureWorkflow('fails-once', {
      stages: {
        run: {
          activity: 'fails-once',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    world.configureWorkflow('succeeds', {
      stages: {
        run: {
          activity: 'succeeds',
          with: {},
          on: { done: { then: 'done' } },
          requiresApproval: false,
        },
      },
    });
    const failedWork = await world.createWork({ objective: 'fail once' });
    const readyWork = await world.createWork({ objective: 'advance independently' });
    const failed = await world.startWorkflow({
      workItemId: failedWork.workItemId,
      workflowName: workflowName('fails-once'),
    });
    const ready = await world.startWorkflow({
      workItemId: readyWork.workItemId,
      workflowName: workflowName('succeeds'),
    });

    await expect(world.advance()).resolves.toMatchObject({
      kind: 'blocked',
      workflowInstanceId: failed.workflowInstanceId,
      reason: 'runner exited 1',
    });
    expect((await world.viewRuns())[0]).toMatchObject({ status: 'failed' });
    await expect(world.advance()).resolves.toMatchObject({ kind: 'progressed' });
    expect((await world.viewWorkflow(failed.workflowInstanceId))?.status).toBe('blocked');
    expect((await world.viewWorkflow(ready.workflowInstanceId))?.status).toBe('completed');
    expect(await world.viewRuns()).toHaveLength(2);
  },
);
