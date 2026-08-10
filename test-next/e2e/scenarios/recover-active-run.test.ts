import { expect, it } from 'vitest';
import { z } from 'zod';

import { activityName } from '../../../src-next/activities/index.js';
import { workflowName } from '../../../src-next/orchestration/index.js';
import { TestWorld } from '../support/world.js';

const recoveryScenario = { id: 'E2E-EXEC-RECOVER-001' } as const;

it(`${recoveryScenario.id} restarts after external completion before the Run result append`, async () => {
  const world = new TestWorld();
  let starts = 0;
  world.registerActivity({
    name: activityName('external-run'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(_invocation, context) {
        starts++;
        await context.reportExternalExecution({
          kind: 'process',
          id: 'process-1',
          startedAt: context.occurredAt,
        });
        return new Promise(() => {});
      },
    },
  });
  world.configureWorkflow('recoverable', {
    stages: {
      run: {
        activity: 'external-run',
        with: {},
        execution: { workspace: 'none' },
        on: { done: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  const work = await world.createWork({ objective: 'recover completed process' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('recoverable'),
  });
  void world.advance(work.workItemId);
  await activeRun(world);

  world.clock.advance(60_001);
  world.restartExecution({
    async inspect() {
      return {
        kind: 'completed' as const,
        result: { transport: 'succeeded' as const, output: '{"kind":"done"}', runner: 'fake' },
      };
    },
  });

  await expect(world.advance(work.workItemId)).resolves.toMatchObject({ kind: 'progressed' });
  expect((await world.viewRuns())[0]).toMatchObject({ status: 'succeeded' });
  expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
  expect(starts).toBe(1);
});

async function activeRun(world: TestWorld) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [run] = await world.viewRuns();
    if (run?.externalExecution !== undefined) return run;
    await Promise.resolve();
  }
  throw new Error('Expected an active fake Run');
}

it('E2E-EXEC-RECOVER-002 escalates unknown recovery and accepts an operator resolution', async () => {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('unknown-external-run'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(_invocation, context) {
        await context.reportExternalExecution({
          kind: 'process',
          id: 'process-unknown',
          startedAt: context.occurredAt,
        });
        return new Promise(() => {});
      },
    },
  });
  world.configureWorkflow('unknown-recoverable', {
    stages: {
      run: {
        activity: 'unknown-external-run',
        with: {},
        execution: { workspace: 'none' },
        on: { done: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  const work = await world.createWork({ objective: 'recover unknown process' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('unknown-recoverable'),
  });
  void world.advance(work.workItemId);
  const run = await activeRun(world);
  world.clock.advance(60_001);
  world.restartExecution({
    async inspect() {
      return { kind: 'unknown' as const, reason: 'runner unavailable' };
    },
  });

  await world.advance(work.workItemId);
  await world.advance(work.workItemId);
  await world.advance(work.workItemId);
  expect((await world.viewRuns())[0]).toMatchObject({ status: 'ambiguous', escalated: true });
  expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('blocked');

  await world.resolveRun(run.runId, { kind: 'succeeded', outcome: { kind: 'done' } });
  await expect(world.advance(work.workItemId)).resolves.toMatchObject({ kind: 'progressed' });
  expect((await world.viewWorkflow(workflow.workflowInstanceId))?.status).toBe('completed');
});
