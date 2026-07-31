import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
  workflowName,
} from '../../src-next/orchestration/contracts/identifiers.js';
import { activityName } from '../../src-next/activities/index.js';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { ActivityRegistry } from '../../src-next/activities/index.js';
import {
  correlationId,
  type CommandContext,
  type EventJournal,
} from '../../src-next/kernel/index.js';
import {
  compileWorkflow,
  createOrchestrationService,
  type ChildWorkflowRequest,
  type GroupBudgetExhaustedView,
  type WorkflowInstanceView,
} from '../../src-next/orchestration/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { createWorkService, workItemId } from '../../src-next/work/index.js';
import { FakeClock } from '../e2e/support/world.js';

const context = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('coordination-1'),
  occurredAt: '2026-07-30T12:00:00.000Z',
  actor: { kind: 'system', id: 'test' },
});

async function fixture() {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  await work.create(
    { workItemId: workItemId('work-1'), objective: 'coordinate children' },
    context('create-work-1'),
  );
  await work.create(
    { workItemId: workItemId('work-2'), objective: 'other work' },
    context('create-work-2'),
  );
  const activities = new ActivityRegistry();
  activities.register({
    name: activityName('parent-work'),
    inputSchema: z.object({}).strict(),
    outcomeSchema: z.object({ kind: z.literal('blocked') }).strict(),
    outcomeKinds: ['blocked'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'blocked' } as const;
      },
    },
  });
  activities.register({
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
  const definitions = {
    parent: compileWorkflow(
      'parent',
      {
        stages: {
          work: {
            activity: 'parent-work',
            with: {},
            on: { blocked: { then: 'await-human' } },
          },
        },
      },
      activities,
      ['parent', 'child'],
    ),
    child: compileWorkflow(
      'child',
      {
        stages: {
          work: { activity: 'child-work', with: {}, on: { done: { then: 'done' } } },
        },
      },
      activities,
      ['parent', 'child'],
    ),
  };
  const service = createOrchestrationService(journal, work, definitions);
  return { definitions, journal, service, work };
}

async function startParent(
  service: Awaited<ReturnType<typeof fixture>>['service'],
  id = 'parent-1',
) {
  return service.start(
    {
      workflowInstanceId: workflowInstanceId(id),
      workItemId: workItemId('work-1'),
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId('group-1'),
    },
    context(`start-${id}`),
  );
}

const childRequest = (
  triggerId: string,
  parentWorkflowInstanceId = 'parent-1',
): ChildWorkflowRequest & { readonly maxPerGroup: number } => ({
  parentWorkflowInstanceId: workflowInstanceId(parentWorkflowInstanceId),
  watchId: 'review',
  triggerId,
  workflowName: workflowName('child'),
  causalCycleId: `${parentWorkflowInstanceId}:cycle:${triggerId}`,
  requestId: workflowInstanceId(`${parentWorkflowInstanceId}:watch:review:trigger:${triggerId}`),
  maxPerGroup: 1,
});

it('allows only one primary start in a Promise.all race', async () => {
  const { journal, service } = await fixture();
  const results = await Promise.allSettled([
    startParent(service, 'primary-a'),
    startParent(service, 'primary-b'),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const roots = (await journal.readAll(0)).filter(
    (event) =>
      event.eventType === 'orchestration.instance-started' &&
      !(event.payload as Record<string, unknown>).parentWorkflowInstanceId,
  );
  expect(roots).toHaveLength(1);
});

it('enforces a group budget in a Promise.all race and durably records the loser', async () => {
  const { journal, service } = await fixture();
  await startParent(service);
  const results = await Promise.allSettled([
    service.requestChild(childRequest('trigger-a'), context('request-a')),
    service.requestChild(childRequest('trigger-b'), context('request-b')),
    service.requestChild(childRequest('trigger-c'), context('request-c')),
  ]);
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  expect(
    (await journal.readAll(0)).filter((event) => event.eventType === 'orchestration.child-started'),
  ).toHaveLength(1);
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === 'orchestration.group-budget-exhausted',
    ),
  ).toHaveLength(2);
  await expect(
    service.requestChild(childRequest('trigger-c'), context('request-c-retry')),
  ).resolves.toMatchObject({ kind: 'group-budget-exhausted' });
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === 'orchestration.group-budget-exhausted',
    ),
  ).toHaveLength(2);
});

it('rejects incomplete, fake, and mismatched child provenance before starting', async () => {
  const incomplete = await fixture();
  await expect(
    incomplete.service.start(
      {
        workflowInstanceId: workflowInstanceId('incomplete-child'),
        workItemId: workItemId('work-1'),
        workflowName: workflowName('child'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        watchId: 'review',
      } as never,
      context('incomplete'),
    ),
  ).rejects.toThrow(/child provenance/i);

  const { journal, service } = await fixture();
  await startParent(service);
  const base = (workflowInstanceId: string) => ({
    workflowName: workflowName('child'),
    watchId: 'review',
    triggerId: 'trigger-1',
    causalCycleId: 'cycle-1',
    requestId: workflowInstanceId,
  });
  await expect(
    service.start(
      {
        ...base('fake-parent-child'),
        workflowInstanceId: workflowInstanceId('fake-parent-child'),
        workItemId: workItemId('work-1'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        parentWorkflowInstanceId: workflowInstanceId('missing-parent'),
      },
      context('fake-parent'),
    ),
  ).rejects.toThrow(/does not exist/);
  await expect(
    service.start(
      {
        ...base('wrong-work-child'),
        workflowInstanceId: workflowInstanceId('wrong-work-child'),
        workItemId: workItemId('work-2'),
        orchestrationGroupId: orchestrationGroupId('group-1'),
        parentWorkflowInstanceId: workflowInstanceId('parent-1'),
      },
      context('wrong-work'),
    ),
  ).rejects.toThrow(/WorkItem and orchestration group/);
  await expect(
    service.start(
      {
        ...base('wrong-group-child'),
        workflowInstanceId: workflowInstanceId('wrong-group-child'),
        workItemId: workItemId('work-1'),
        orchestrationGroupId: orchestrationGroupId('other-group'),
        parentWorkflowInstanceId: workflowInstanceId('parent-1'),
      },
      context('wrong-group'),
    ),
  ).rejects.toThrow(/WorkItem and orchestration group/);
  expect(
    (await journal.readAll(0)).filter(
      (event) =>
        event.eventType === 'orchestration.child-started' &&
        ['incomplete-child', 'fake-parent-child', 'wrong-work-child', 'wrong-group-child'].includes(
          event.stream.id,
        ),
    ),
  ).toHaveLength(0);
});

it('does not consume a completion rejected by the parent signal expectation', async () => {
  const { journal, service } = await fixture();
  const parent = await startParent(service);
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: parent.workflowInstanceId,
      activationId: parent.pendingActivation!.activationId,
      outcome: { kind: 'blocked' },
    },
    context('block-parent'),
  );
  await service.waitForSignal(
    waiting.workflowInstanceId,
    { signalKind: signalName('some-other-signal') },
    context('wait-for-other'),
  );
  const child = requireStarted(
    await service.requestChild(childRequest('trigger-1'), context('request-child')),
  );
  await service.acceptOutcome(
    {
      workflowInstanceId: child.workflowInstanceId,
      activationId: child.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('complete-child'),
  );
  expect(await eventsOf(journal, 'orchestration.child-completed')).toHaveLength(1);
  expect(await eventsOf(journal, 'orchestration.child-completion-consumed')).toHaveLength(0);
});

it('does not consume a completion while its parent is active', async () => {
  const { journal, service } = await fixture();
  await startParent(service);
  const child = requireStarted(
    await service.requestChild(childRequest('trigger-1'), context('request-child')),
  );
  await service.acceptOutcome(
    {
      workflowInstanceId: child.workflowInstanceId,
      activationId: child.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('complete-child'),
  );
  expect(await eventsOf(journal, 'orchestration.child-completed')).toHaveLength(1);
  expect(await eventsOf(journal, 'orchestration.child-completion-consumed')).toHaveLength(0);
});

it('uses durable group provenance to distinguish repeated and unrelated causal cycles', async () => {
  const { definitions, journal, service, work } = await fixture();
  await startParent(service);
  const request = childRequest('trigger-1');
  await service.requestChild(request, context('request-child'));
  const restarted = createOrchestrationService(journal, work, definitions);
  await expect(
    restarted.isCausalRepeat(
      workflowInstanceId('parent-1'),
      'unrelated-trigger',
      'unrelated-cycle',
    ),
  ).resolves.toBe(false);
  await expect(
    restarted.isCausalRepeat(
      workflowInstanceId('parent-1'),
      'completion-event',
      request.causalCycleId,
    ),
  ).resolves.toBe(true);
});

it('records typed metadata for every child coordination outcome', async () => {
  const { journal, service } = await fixture();
  const parent = await startParent(service);
  const waiting = await service.acceptOutcome(
    {
      workflowInstanceId: parent.workflowInstanceId,
      activationId: parent.pendingActivation!.activationId,
      outcome: { kind: 'blocked' },
    },
    context('block-parent'),
  );
  await service.waitForSignal(
    waiting.workflowInstanceId,
    { signalKind: signalName('orchestration.child-completed') },
    context('wait-child'),
  );
  const child = requireStarted(
    await service.requestChild(childRequest('trigger-1'), context('request-child')),
  );
  await service.acceptOutcome(
    {
      workflowInstanceId: child.workflowInstanceId,
      activationId: child.pendingActivation!.activationId,
      outcome: { kind: 'done' },
    },
    context('complete-child'),
  );
  await service.requestChild(childRequest('trigger-2'), context('over-budget'));
  await service.rejectCausalActivation(childRequest('trigger-1'), context('reject-cycle'));
  await expectCoordinationMetadata(journal, child.workflowInstanceId);
});

async function eventsOf(journal: EventJournal, eventType: string) {
  return (await journal.readAll(0)).filter((event) => event.eventType === eventType);
}

function requireStarted(
  result: WorkflowInstanceView | GroupBudgetExhaustedView,
): WorkflowInstanceView {
  if ('kind' in result) throw new Error('Expected a started child workflow');
  return result;
}

async function expectCoordinationMetadata(journal: EventJournal, childId: string) {
  const types = [
    'orchestration.child-requested',
    'orchestration.child-started',
    'orchestration.child-completed',
    'orchestration.child-completion-consumed',
    'orchestration.causal-activation-rejected',
    'orchestration.group-budget-exhausted',
  ];
  for (const eventType of types) {
    const [event] = await eventsOf(journal, eventType);
    expect(event?.payload, eventType).toEqual(
      expect.objectContaining({
        parentWorkflowInstanceId: workflowInstanceId('parent-1'),
        watchId: 'review',
        orchestrationGroupId: orchestrationGroupId('group-1'),
        causalCycleId: expect.any(String),
        requestId: expect.any(String),
        childWorkflowInstanceId: expect.any(String),
      }),
    );
  }
  const [accepted] = await eventsOf(journal, 'orchestration.signal-accepted');
  expect(accepted?.payload).toEqual(
    expect.objectContaining({
      kind: 'orchestration.child-completed',
      providerEventId: childId,
    }),
  );
  const [signal, consumed] = await Promise.all([
    eventsOf(journal, 'orchestration.signal-accepted'),
    eventsOf(journal, 'orchestration.child-completion-consumed'),
  ]);
  expect(signal[0]!.globalPosition).toBeLessThan(consumed[0]!.globalPosition);
}
