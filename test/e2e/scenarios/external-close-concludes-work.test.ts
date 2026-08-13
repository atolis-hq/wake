import { expect, it } from 'vitest';
import { z } from 'zod';
import { resId } from '../../support/identities.js';

import { activityName } from '../../../src/activities/index.js';
import { correlationId } from '../../../src/kernel/index.js';
import { workflowName } from '../../../src/orchestration/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { TestWorld } from '../support/world.js';

const scenario = { id: 'E2E-WORK-003' } as const;

it(`${scenario.id} closes Work without treating the cancelled Run as its lifecycle state`, async () => {
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
  world.configureWorkflow('closable', {
    stages: {
      run: {
        activity: 'long-running',
        with: {},
        execution: { workspace: 'none' },
        on: { done: { then: 'done' } },
      },
    },
  });
  const work = await world.createWork({ objective: 'close via external ticket completion' });
  const resource = await world.discoverResource({
    resourceId: resId('1'),
    kind: resourceKind('issue'),
    externalKey: { adapter: 'fake', key: 'issues/1' },
    capabilities: [],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate',
    correlationId: correlationId('close'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('closable'),
  });
  const advancing = world.advance(work.workItemId);
  await activeRun(world);

  await world.closeWork(work.workItemId, 'issue closed as completed');

  expect(await world.viewWork(work.workItemId)).toMatchObject({ state: 'closed' });
  expect((await world.viewRuns())[0]).toMatchObject({
    status: 'cancelled',
    cancellation: { reason: 'work-closed', confirmedAt: expect.any(String) },
  });

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
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Expected an active fake Run');
}
