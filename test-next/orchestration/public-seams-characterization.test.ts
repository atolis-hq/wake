import { z } from 'zod';
import { expect, it } from 'vitest';

import { ActivityRegistry, activityName } from '../../src-next/activities/index.js';
import { correlationId, type CommandContext } from '../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import {
  OrchestrationEventType,
  compileWorkflow,
  createOrchestrationService,
  foldWorkflowInstance,
  orchestrationGroupId,
  selectWorkflowOrchestrationEvent,
  signalName,
  workflowInstanceId,
  workflowInstanceStream,
  workflowName,
  type OrchestrationService,
} from '../../src-next/orchestration/index.js';
import { createWorkService, workItemId } from '../../src-next/work/index.js';

const occurredAt = '2026-07-30T12:00:00.000Z';
const context = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('public-orchestration'),
  occurredAt,
  actor: { kind: 'system', id: 'characterization' },
});

function activities() {
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('parent-work'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('done') }).strict(),
      z
        .object({
          kind: z.literal('failed'),
          data: z
            .object({
              retrySafety: z.enum(['safe-to-retry', 'requires-reconciliation']),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z.object({ kind: z.literal('blocked') }).strict(),
    ]),
    outcomeKinds: ['done', 'failed', 'blocked'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' } as const;
      },
    },
  });
  registry.register({
    name: activityName('child-work'),
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
  return registry;
}

async function fixture() {
  const clock = { now: () => new Date(occurredAt) };
  const journal = new InMemoryEventJournal(clock);
  const work = createWorkService(journal);
  await work.create(
    { workItemId: workItemId('work-public'), objective: 'characterize orchestration' },
    context('create-work'),
  );
  const registry = activities();
  const definitions = {
    parent: compileWorkflow(
      'parent',
      {
        stages: {
          work: {
            activity: 'parent-work',
            with: {},
            on: {
              done: { then: 'done' },
              failed: { retry: { max: 1 }, then: 'await-human' },
              blocked: { then: 'await-human' },
            },
          },
        },
      },
      registry,
      ['parent', 'child'],
    ),
    child: compileWorkflow(
      'child',
      {
        stages: {
          work: { activity: 'child-work', with: {}, on: { done: { then: 'done' } } },
        },
      },
      registry,
      ['parent', 'child'],
    ),
  };
  const service = createOrchestrationService(journal, work, definitions);
  const primary = await startPrimary(service);
  return { journal, primary, service };
}

function startPrimary(service: OrchestrationService) {
  return service.start(
    {
      workflowInstanceId: workflowInstanceId('primary-public'),
      workItemId: workItemId('work-public'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('group-public'),
    },
    context('start-primary'),
  );
}

function requestChild(service: OrchestrationService, triggerId: string) {
  return service.requestChild(
    {
      parentWorkflowInstanceId: workflowInstanceId('primary-public'),
      watchId: 'review',
      triggerId,
      workflowName: workflowName('child'),
      causalCycleId: `cycle-${triggerId}`,
      requestId: workflowInstanceId(`primary-public:watch:review:trigger:${triggerId}`),
      maxPerGroup: 1,
    },
    context(`request-${triggerId}`),
  );
}

it('starts one primary WorkflowInstance', async () => {
  const { service } = await fixture();

  await expect(
    service.start(
      {
        workflowInstanceId: workflowInstanceId('second-primary'),
        workItemId: workItemId('work-public'),
        workflowName: workflowName('parent'),
        orchestrationGroupId: orchestrationGroupId('second-group'),
      },
      context('start-second-primary'),
    ),
  ).rejects.toThrow(/primary workflow/i);
  expect(await service.getPrimaryWorkflowInstanceId(workItemId('work-public'))).toBe(
    workflowInstanceId('primary-public'),
  );
});

it('requests and accepts one typed Activity outcome', async () => {
  const { journal, primary, service } = await fixture();

  const completed = await service.acceptOutcome(
    {
      workflowInstanceId: primary.workflowInstanceId,
      activationId: primary.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('accept-done'),
  );

  expect(completed.status).toBe('completed');
  const accepted = (await journal.readAll(0))
    .map(selectWorkflowOrchestrationEvent)
    .find((event) => event?.eventType === OrchestrationEventType.ActivityOutcomeAccepted);
  expect(accepted?.payload.outcome).toEqual({ kind: 'done' });
});

it('waits for and accepts a typed signal', async () => {
  const { primary, service } = await fixture();
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: primary.workflowInstanceId,
      activationId: primary.pendingActivation!.activationId,
      outcome: { kind: 'blocked' },
    },
    context('accept-blocked'),
  );
  await service.waitForSignal(
    waiting.workflowInstanceId,
    { signalKind: signalName('accepted') },
    context('wait-for-accepted'),
  );

  const resumed = await service.acceptSignal(
    waiting.workflowInstanceId,
    {
      kind: signalName('accepted'),
      actorId: 'operator',
      actorDecision: { authorized: true, evidenceId: 'decision-1' },
      providerEventId: 'provider-event-1',
    },
    context('accept-signal'),
  );

  expect(resumed.acceptedSignalIds).toEqual(['provider-event-1']);
  expect(resumed.pendingActivation?.ordinal).toBe(2);
});

it('retries without resetting the group budget', async () => {
  const { primary, service } = await fixture();
  await requestChild(service, 'first');

  const retried = await service.acceptOutcome(
    {
      workflowInstanceId: primary.workflowInstanceId,
      activationId: primary.pendingActivation!.activationId,
      outcome: { kind: 'failed', data: { retrySafety: 'safe-to-retry' } },
    },
    context('accept-failed'),
  );
  const second = await requestChild(service, 'second');

  expect(retried.retryCounts).toEqual({ 'work:failed': 1 });
  expect(second).toEqual({
    kind: 'group-budget-exhausted',
    requestId: 'primary-public:watch:review:trigger:second',
  });
});

it('coordinates a child without a parent-child success loop', async () => {
  const { journal, primary, service } = await fixture();
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: primary.workflowInstanceId,
      activationId: primary.pendingActivation!.activationId,
      outcome: { kind: 'blocked' },
    },
    context('block-parent'),
  );
  await service.waitForSignal(
    waiting.workflowInstanceId,
    { signalKind: signalName(OrchestrationEventType.ChildCompleted) },
    context('wait-for-child'),
  );
  const child = await requestChild(service, 'completion');
  if ('kind' in child) throw new Error('Expected child WorkflowInstance');

  await service.acceptOutcome(
    {
      workflowInstanceId: child.workflowInstanceId,
      activationId: child.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('complete-child'),
  );
  await service.reconcileChildCompletions(context('reconcile-again'));

  const parent = await service.get(primary.workflowInstanceId);
  expect(parent?.acceptedChildCompletionIds).toEqual([child.workflowInstanceId]);
  expect(await service.listAll()).toHaveLength(2);
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === OrchestrationEventType.ChildCompletionConsumed,
    ),
  ).toHaveLength(1);
});

it('replays the same event sequence to the same public view', async () => {
  const { journal, primary, service } = await fixture();
  await service.acceptOutcome(
    {
      workflowInstanceId: primary.workflowInstanceId,
      activationId: primary.pendingActivation!.activationId,
      outcome: { kind: 'failed', data: { retrySafety: 'safe-to-retry' } },
    },
    context('retry-before-replay'),
  );
  const live = await service.get(primary.workflowInstanceId);
  const persisted = await journal.readStream(workflowInstanceStream(primary.workflowInstanceId));
  const owned = persisted.map(selectWorkflowOrchestrationEvent).filter((event) => event !== null);

  expect(foldWorkflowInstance(owned)).toEqual(live);
  expect(foldWorkflowInstance(owned)).toEqual(foldWorkflowInstance(owned));
});
