import { expect } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/contracts/identifiers.js';
import { defineScenario } from '../support/scenario.js';
import { TestWorld } from '../support/world.js';

defineScenario(
  {
    id: 'E2E-LIFECYCLE-001',
    title: 'a two-stage workflow completes when both agents succeed first try',
    given: ['a default-shaped workflow with a refine stage then an implement stage'],
    when: ['the refine agent succeeds and then the implement agent succeeds'],
    then: [
      'both stages are entered in order, each producing one successful Run',
      'the workflow reaches completed and the work item stays open',
    ],
  },
  async () => {
    const world = new TestWorld();
    for (const name of ['refine', 'implement'] as const) {
      world.registerActivity({
        name: activityName(name),
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
    }
    world.configureWorkflow('default', {
      stages: {
        refine: {
          activity: 'refine',
          with: {},
          execution: { workspace: 'none' },
          on: { done: { then: 'implement' } },
        },
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
      workflowName: workflowName('default'),
    });
    await world.advance(work.workItemId);
    await world.advance(work.workItemId);
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
    expect((await world.viewWorkflow(workflow.workflowInstanceId))?.currentStage).toBe('implement');
    const runs = await world.viewRuns();
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'succeeded' && run.outcome?.kind === 'done')).toBe(
      true,
    );
    expect(
      (await world.events('orchestration.stage-entered')).map((event) => event.payload),
    ).toEqual([{ stage: 'refine' }, { stage: 'implement' }]);
    expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'open' });
  },
);
