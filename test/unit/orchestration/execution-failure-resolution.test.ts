import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { workflowName } from '../../../src/orchestration/index.js';
import { TestWorld } from '../../e2e/support/world.js';

it('records one execution failure and blocks its pending activation', async () => {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('agent'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('done') }).strict(),
    outcomeKinds: ['done'],
    resources: [],
    executionKind: 'deterministic',
    handler: { async execute() { return { kind: 'done' } as const; } },
  });
  world.configureWorkflow('default', {
    stages: {
      implement: {
        activity: 'agent',
        with: {},
        on: { done: { then: 'done' } },
        requiresApproval: false,
      },
    },
  });
  const work = await world.createWork({ objective: 'record a runner failure' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('default'),
  });

  await world.resolveExecutionFailure(workflow.workflowInstanceId, {
    activationId: workflow.pendingActivation!.activationId,
    runId: 'run-failed',
    reason: 'runner exited 1',
  });
  await world.resolveExecutionFailure(workflow.workflowInstanceId, {
    activationId: workflow.pendingActivation!.activationId,
    runId: 'run-failed',
    reason: 'runner exited 1',
  });

  await expect(world.viewWorkflow(workflow.workflowInstanceId)).resolves.toMatchObject({
    status: 'blocked',
    blockReason: 'runner exited 1',
    pendingActivation: { status: 'completed' },
    acceptedOutcomes: [workflow.pendingActivation!.activationId],
  });
  expect(await world.events('orchestration.activity-execution-failed')).toHaveLength(1);
  expect(await world.events('orchestration.instance-blocked')).toHaveLength(1);
});
