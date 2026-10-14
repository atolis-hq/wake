import { EventActorKind, correlationId } from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import { isOperatorRetryEligible, workflowName } from '../../../src/orchestration/index.js';
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
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
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
    executionFailure: {
      activationId: workflow.pendingActivation!.activationId,
      runId: 'run-failed',
      reason: 'runner exited 1',
    },
  });
  expect(await world.events('orchestration.activity-execution-failed')).toHaveLength(1);
  expect(await world.events('orchestration.instance-blocked')).toHaveLength(1);
});

it('converts an ambiguity block into a retryable execution failure after an operator resolution', async () => {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('agent'),
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
  const work = await world.createWork({ objective: 'resolve an ambiguous run as failed' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('default'),
  });
  await world.blockWorkflow(
    workflow.workflowInstanceId,
    'execution-recovery-ambiguous: runner inspection unavailable',
  );

  await world.resolveExecutionFailure(workflow.workflowInstanceId, {
    activationId: workflow.pendingActivation!.activationId,
    runId: 'run-ambiguous',
    reason: 'The external process cannot be verified.',
  });

  await expect(world.viewWorkflow(workflow.workflowInstanceId)).resolves.toMatchObject({
    status: 'blocked',
    blockReason: 'The external process cannot be verified.',
    pendingActivation: { status: 'completed' },
    executionFailure: { runId: 'run-ambiguous' },
  });
  expect(isOperatorRetryEligible((await world.viewWorkflow(workflow.workflowInstanceId))!)).toBe(
    true,
  );
});

async function recoveryBlockWorld() {
  const world = new TestWorld();
  world.registerActivity({
    name: activityName('agent'),
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
  const work = await world.createWork({ objective: 'recovery block guard' });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('default'),
  });
  const block = (activationId: string) =>
    world.orchestration.blockAwaitingActivation(
      workflow.workflowInstanceId,
      activationId as never,
      'execution-recovery-ambiguous: run run-1: unknown',
      {
        commandId: `recovery:${activationId}`,
        correlationId: correlationId('recovery'),
        occurredAt: world.clock.now().toISOString(),
        actor: { kind: EventActorKind.System, id: 'execution-recovery' },
      },
    );
  return { world, workflow, block };
}

it('blocks a workflow that is still waiting on the ambiguous run activation', async () => {
  const { world, workflow, block } = await recoveryBlockWorld();
  await block(workflow.pendingActivation!.activationId);
  await expect(world.viewWorkflow(workflow.workflowInstanceId)).resolves.toMatchObject({
    status: 'blocked',
  });
});

it('does not block a workflow that has completed since the run became ambiguous', async () => {
  const { world, workflow, block } = await recoveryBlockWorld();
  const activationId = workflow.pendingActivation!.activationId;
  await world.acceptOutcome(workflow.workflowInstanceId, activationId, { kind: 'done' });
  await block(activationId);
  await expect(world.viewWorkflow(workflow.workflowInstanceId)).resolves.toMatchObject({
    status: 'completed',
  });
});

it('does not block a workflow waiting on a different activation', async () => {
  const { world, workflow, block } = await recoveryBlockWorld();
  await block('some-other-activation');
  await expect(world.viewWorkflow(workflow.workflowInstanceId)).resolves.toMatchObject({
    status: 'active',
  });
});
