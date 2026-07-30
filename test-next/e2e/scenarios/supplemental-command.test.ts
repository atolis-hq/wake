import { z } from 'zod';
import { expect } from 'vitest';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-ORCH-COMMAND-001',
    title: 'a provider-neutral supplemental review preserves the primary stage',
    given: ['a configured /codereview command and active implementation'],
    when: ['the command is queued and both Activities complete'],
    then: ['review runs sequentially and implementation remains the primary stage'],
  },
  async () => {
    const world = new TestWorld();
    for (const name of ['implement', 'review']) {
      world.registerActivity({
        name,
        inputSchema: z.object({ prompt: z.string() }).strict(),
        outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
        resources: [],
        executionKind: 'deterministic',
        handler: {
          async execute() {
            return { kind: 'done' };
          },
        },
      });
    }
    world.configureWorkflow('default', {
      commands: {
        '/codereview': {
          activity: 'review',
          with: { prompt: 'review the current change' },
          allowedActors: ['operator'],
        },
      },
      stages: {
        implement: {
          activity: 'implement',
          with: { prompt: 'implement' },
          on: { done: { then: 'done' } },
        },
      },
    });
    const work = await world.createWork({ objective: 'review without transition' });
    const workflow = await world.startWorkflow({
      workItemId: work.workItemId,
      workflowName: 'default',
    });
    await world.requestSupplementalActivity(workflow.workflowInstanceId, {
      command: '/codereview',
    });
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    const resumed = await world.viewWorkflow(workflow.workflowInstanceId);
    expect((await world.viewRuns()).map((run) => run.activity)).toEqual(['implement', 'review']);
    expect(resumed).toMatchObject({
      currentStage: 'implement',
      status: 'active',
      supplementalQueue: [],
      pendingActivation: { activity: 'implement', ordinal: 3 },
    });
  },
);
