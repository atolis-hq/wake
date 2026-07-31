import { z } from 'zod';
import { expect, it } from 'vitest';

import { activityName } from '../../../src-next/activities/index.js';
import { correlationId } from '../../../src-next/kernel/index.js';
import { resourceId, resourceKind } from '../../../src-next/resources/index.js';
import { workflowName } from '../../../src-next/orchestration/index.js';
import { TestWorld } from '../support/world.js';

it('E2E-EXEC-CANCEL-001 cancels Work with a live fake Run across Execution restart', async () => {
  const world = new TestWorld();
  let complete!: () => void;
  world.registerActivity({
    name: activityName('long-running'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute(_invocation, context) {
        await context.reportExternalExecution({
          kind: 'process',
          id: 'fake-process-1',
          startedAt: context.occurredAt,
        });
        return new Promise((resolve) => {
          complete = () => resolve({ kind: 'done' });
        });
      },
    },
  });
  world.configureWorkflow('cancelable', {
    stages: {
      run: {
        activity: 'long-running',
        with: {},
        execution: { workspace: 'none' },
        on: { done: { then: 'done' } },
      },
    },
  });
  const work = await world.createWork({ objective: 'cancel an active Run' });
  const resource = await world.discoverResource({
    resourceId: resourceId('resource-1'),
    kind: resourceKind('issue'),
    externalKey: { adapter: 'fake', key: 'issues/1' },
    capabilities: [],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate',
    correlationId: correlationId('cancel'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('cancelable'),
  });
  const advancing = world.advance(work.workItemId);
  await activeRun(world);

  await world.cancelWork(work.workItemId);
  world.restartExecution();

  expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'cancelled' });
  expect((await world.viewRuns())[0]).toMatchObject({
    status: 'cancelled',
    cancellation: { reason: 'work-cancelled', confirmedAt: expect.any(String) },
  });
  expect((await world.events()).map((event) => event.eventType)).toContain(
    'execution.run-cancellation-requested',
  );
  expect((await world.events()).map((event) => event.eventType)).toContain(
    'execution.run-cancellation-confirmed',
  );

  complete();
  await expect(advancing).resolves.toMatchObject({ kind: 'blocked' });
  expect(await world.viewWorkflow(workflow.workflowInstanceId)).toMatchObject({
    status: 'blocked',
  });
});

async function activeRun(world: TestWorld) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [run] = await world.viewRuns();
    if (run?.externalExecution !== undefined) return run;
    await Promise.resolve();
  }
  throw new Error('Expected an active fake Run');
}
