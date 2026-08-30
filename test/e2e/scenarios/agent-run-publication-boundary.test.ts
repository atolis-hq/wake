import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName } from '../../../src/activities/index.js';
import {
  ExecutionEventType,
  RunRepository,
  runId,
  runStream,
} from '../../../src/execution/index.js';
import { AgentRunPublicationReactor } from '../../../src/integrations/application/agent-run-publication-reactor.js';
import { projectDeliveries } from '../../../src/integrations/delivery/application/delivery-projector.js';
import { BuiltInAdapterId } from '../../../src/integrations/github/index.js';
import { correlationId, createEventDraft } from '../../../src/kernel/index.js';
import { workflowName } from '../../../src/orchestration/index.js';
import { resourceKind } from '../../../src/resources/index.js';
import { resId } from '../../support/identities.js';
import { TestWorld } from '../support/world.js';

it('E2E-AGENT-PUBLICATION-001 waits for the approval decision before publishing Done', async () => {
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
    stages: { refine: { activity: 'agent', with: {}, on: { done: { then: 'done' } } } },
  });
  const work = await world.createWork({ objective: 'publish after approval wait' });
  const resource = await world.discoverResource({
    resourceId: resId('1'),
    kind: resourceKind('issue'),
    externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'owner/repo#7' },
    capabilities: [],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate-resource',
    correlationId: correlationId('publication-boundary'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('default'),
  });
  const activation = workflow.pendingActivation!.activationId;
  const run = runId('run-publication-boundary');
  await appendTerminalAgentRun(world, run, workflow.workflowInstanceId, activation);
  const publications = new AgentRunPublicationReactor({
    journal: world.journal,
    runs: new RunRepository(world.journal),
    resources: world.resources,
    orchestration: world.orchestration,
  });

  await world.process(publications.processor);
  expect(projectDeliveries(await world.journal.readAll(0))).toEqual([]);

  await world.acceptOutcome(workflow.workflowInstanceId, activation, { kind: 'done' });
  await world.process(publications.processor);
  await world.checkpoints.reset('reactor:agent-run-publication');
  await world.process(publications.processor);

  expect(projectDeliveries(await world.journal.readAll(0))).toMatchObject([
    { payload: { report: { runId: run, outcome: 'DONE', awaitingApproval: true } } },
  ]);
});

it('E2E-AGENT-PUBLICATION-002 publishes a transport failure after it is resolved', async () => {
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
    stages: { implement: { activity: 'agent', with: {}, on: { done: { then: 'done' } } } },
  });
  const work = await world.createWork({ objective: 'publish a resolved transport failure' });
  const resource = await world.discoverResource({
    resourceId: resId('2'),
    kind: resourceKind('issue'),
    externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'owner/repo#8' },
    capabilities: [],
  });
  await world.resources.correlate(resource.resourceId, work.workItemId, 'primary', {
    commandId: 'correlate-resource',
    correlationId: correlationId('publication-failure'),
    occurredAt: world.clock.now().toISOString(),
    actor: { kind: 'operator', id: 'owner' },
  });
  const workflow = await world.startWorkflow({
    workItemId: work.workItemId,
    workflowName: workflowName('default'),
  });
  const activation = workflow.pendingActivation!.activationId;
  const run = runId('run-publication-failure');
  await appendFailedAgentRun(world, run, workflow.workflowInstanceId, activation);
  const publications = new AgentRunPublicationReactor({
    journal: world.journal,
    runs: new RunRepository(world.journal),
    resources: world.resources,
    orchestration: world.orchestration,
  });

  await world.process(publications.processor);
  expect(projectDeliveries(await world.journal.readAll(0))).toEqual([]);

  await world.resolveExecutionFailure(workflow.workflowInstanceId, {
    activationId: activation,
    runId: run,
    reason: 'runner exited 1',
  });
  await world.process(publications.processor);
  await world.process(publications.processor);

  await expect(world.viewWorkflow(workflow.workflowInstanceId)).resolves.toMatchObject({
    status: 'blocked',
    blockReason: 'runner exited 1',
  });
  expect(projectDeliveries(await world.journal.readAll(0))).toMatchObject([
    { payload: { report: { runId: run, outcome: 'FAILED', displayBody: 'runner exited 1' } } },
  ]);
});

async function appendTerminalAgentRun(
  world: TestWorld,
  id: ReturnType<typeof runId>,
  workflowInstanceId: string,
  activationId: string,
) {
  const stream = runStream(id);
  const now = world.clock.now().toISOString();
  await world.journal.append(stream, 0, [
    createEventDraft({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: now,
      correlationId: 'publication-boundary',
      causationId: 'publication-boundary',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        activationId,
        activity: 'agent',
        workflowInstanceId,
        orchestrationGroupId: workflowInstanceId,
        attempt: 1,
        startedAt: now,
      },
    }),
    createEventDraft({
      eventId: `${id}:agent-result`,
      eventType: ExecutionEventType.RunRunnerResultReported,
      occurredAt: now,
      correlationId: 'publication-boundary',
      causationId: 'publication-boundary',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        transport: 'succeeded',
        agent: { outcome: 'DONE', displayBody: 'Plan complete.', metadata: {} },
      },
    }),
    createEventDraft({
      eventId: `${id}:succeeded`,
      eventType: ExecutionEventType.RunSucceeded,
      occurredAt: now,
      correlationId: 'publication-boundary',
      causationId: 'publication-boundary',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { outcome: { kind: 'done' }, finishedAt: now },
    }),
  ] as never);
}

async function appendFailedAgentRun(
  world: TestWorld,
  id: ReturnType<typeof runId>,
  workflowInstanceId: string,
  activationId: string,
) {
  const stream = runStream(id);
  const now = world.clock.now().toISOString();
  await world.journal.append(stream, 0, [
    createEventDraft({
      eventId: `${id}:started`,
      eventType: ExecutionEventType.RunStarted,
      occurredAt: now,
      correlationId: 'publication-failure',
      causationId: 'publication-failure',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        activationId,
        activity: 'agent',
        workflowInstanceId,
        orchestrationGroupId: workflowInstanceId,
        attempt: 1,
        startedAt: now,
      },
    }),
    createEventDraft({
      eventId: `${id}:failed`,
      eventType: ExecutionEventType.RunFailed,
      occurredAt: now,
      correlationId: 'publication-failure',
      causationId: 'publication-failure',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {
        failure: {
          kind: 'unexpected-execution-failure',
          message: 'runner exited 1',
          details: { sourceKind: 'Error' },
        },
        finishedAt: now,
      },
    }),
  ] as never);
}
