import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { workflowName } from '../../../src/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-005',
    title: 'a stage that opts out with requiresApproval: false runs unattended',
    given: ['a workflow whose implement stage sets requiresApproval: false on its done route'],
    when: ['the implement agent succeeds'],
    then: ['the stage advances straight to completed with no signal ever supplied'],
  },
  async () => {
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
          return { kind: 'done' } as const;
        },
      },
    });
    world.configureWorkflow('unattended', {
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
    const work = await world.createWork({ objective: 'ship without a human in the loop' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: workflowName('unattended'),
    });
    await world.advanceUntilSettled(work.workItemId);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect(await world.events('orchestration.signal-wait-started')).toHaveLength(0);
  },
);
