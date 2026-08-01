import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../src-next/activities/index.js';
import { createAdvanceOnce } from '../../src-next/control-plane/index.js';
import { createExecutionService } from '../../src-next/execution/index.js';
import {
  correlationId,
  createEventDraft,
  eventId,
  type CommandContext,
  type EntityRef,
  type EventJournal,
} from '../../src-next/kernel/index.js';
import {
  orchestrationGroupId,
  signalName,
  workflowInstanceId,
  workflowName,
} from '../../src-next/orchestration/contracts/identifiers.js';
import {
  compileWorkflow,
  createOrchestrationService,
  createWatchReactor,
  isWorkflowInstanceStream,
  type OrchestrationService,
} from '../../src-next/orchestration/index.js';
import { InMemoryCheckpointStore, InMemoryEventJournal } from '../../src-next/persistence/index.js';
import { createWorkService, type WorkItemId } from '../../src-next/work/index.js';
import { FakeClock, SequentialIds } from '../e2e/support/world.js';
import { eventEnvelope } from '../support/event-envelope.js';
import { workId } from '../support/identities.js';
import { createTestResourceServices } from '../support/resource-lookup.js';

const command = (commandId: string): CommandContext => ({
  commandId,
  correlationId: correlationId('recovery-1'),
  occurredAt: '2026-07-30T12:00:00.000Z',
  actor: { kind: 'system', id: 'test' },
});

const watchEvent = (id: string) => ({
  ...eventEnvelope('review.requested', {}, { kind: 'test', id: 'coordination-recovery-watch' }),
  eventId: eventId(id),
});

async function fixture() {
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const journal = new InMemoryEventJournal(clock);
  const work = createWorkService(journal);
  for (const id of ['1', '2'])
    await work.create(
      { workItemId: workId(id), objective: `coordinate ${id}` },
      command(`create-work-${id}`),
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
        watches: [
          {
            id: 'review',
            while: { stages: ['work'], statuses: ['active', 'waiting', 'blocked'] },
            on: { events: ['review.requested'] },
            workflow: 'child',
            maxPerGroup: 1,
          },
        ],
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
  return { activities, clock, definitions, ids, journal, service, work };
}

function startPrimary(
  service: OrchestrationService,
  id: string,
  workItem: WorkItemId = workId('1'),
) {
  return service.start(
    {
      workflowInstanceId: workflowInstanceId(id),
      workItemId: workItem,
      workflowName: workflowName('parent'),
      orchestrationGroupId: orchestrationGroupId(id),
    },
    command(`start-${id}`),
  );
}

it('binds durable primary ownership to the first exact WorkflowInstance across a crash', async () => {
  const { definitions, journal, service, work } = await fixture();
  const crashing = createOrchestrationService(
    failWorkflowStartOnce(journal, 'primary-a'),
    work,
    definitions,
  );
  await expect(startPrimary(crashing, 'primary-a')).rejects.toThrow('injected start crash');

  const restarted = createOrchestrationService(journal, work, definitions);
  await expect(startPrimary(restarted, 'primary-b')).rejects.toThrow(/owned by primary-a/);
  expect(await restarted.getPrimaryWorkflowInstanceId(workId('1'))).toBe('primary-a');
  await expect(startPrimary(restarted, 'primary-a')).resolves.toMatchObject({
    workflowInstanceId: workflowInstanceId('primary-a'),
  });
  const roots = (await journal.readAll(0)).filter(
    (event) =>
      event.eventType === 'orchestration.instance-started' &&
      !(event.payload as Record<string, unknown>).parentWorkflowInstanceId,
  );
  expect(roots.map((event) => event.stream.id)).toEqual(['primary-a']);
  expect(await service.get(workflowInstanceId('primary-b'))).toBeNull();
});

it('retries the same durable child claim after a crash before checkpointing the trigger', async () => {
  const { definitions, journal, service, work } = await fixture();
  const parent = await startPrimary(service, 'parent-1');
  const stream: EntityRef<'test', 'watch-trigger'> = {
    kind: 'test',
    id: 'watch-trigger',
  };
  const before = (await journal.readAll(0)).length;
  const [trigger] = await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'review-trigger-1',
      eventType: 'review.requested',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'recovery-1',
      causationId: 'review-trigger-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    }),
  ]);
  const childId = `${parent.workflowInstanceId}:watch:review:trigger:review-trigger-1`;
  const checkpoints = new InMemoryCheckpointStore();
  const crashingService = createOrchestrationService(
    failWorkflowStartOnce(journal, childId),
    work,
    definitions,
  );
  const first = createWatchReactor(crashingService, journal, checkpoints);
  await expect(first.runOnce()).rejects.toThrow('injected start crash');
  expect(await checkpoints.load('reactor:orchestration.watch')).toBe(before);
  expect(await service.get(workflowInstanceId(childId))).toBeNull();

  const restartedService = createOrchestrationService(journal, work, definitions);
  const restarted = createWatchReactor(restartedService, journal, checkpoints);
  await restarted.runOnce();
  expect(await checkpoints.load('reactor:orchestration.watch')).toBeGreaterThanOrEqual(
    trigger!.globalPosition,
  );
  expect((await service.get(workflowInstanceId(childId)))?.workflowInstanceId).toBe(childId);
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === 'orchestration.child-requested',
    ),
  ).toHaveLength(1);
  await expect(
    restartedService.requestChild(
      {
        parentWorkflowInstanceId: parent.workflowInstanceId,
        watchId: 'review',
        triggerId: 'distinct-trigger',
        workflowName: workflowName('child'),
        causalCycleId: 'distinct-cycle',
        requestId: workflowInstanceId(
          `${parent.workflowInstanceId}:watch:review:trigger:distinct-trigger`,
        ),
        maxPerGroup: 1,
      },
      command('distinct-request'),
    ),
  ).resolves.toEqual({
    kind: 'group-budget-exhausted',
    requestId: `${parent.workflowInstanceId}:watch:review:trigger:distinct-trigger`,
  });
  expect(
    (await journal.readAll(0)).filter((event) => event.eventType === 'orchestration.group-claimed'),
  ).toHaveLength(1);
});

it('uses unique durable event identities for the same trigger across two parents', async () => {
  const { journal, service } = await fixture();
  await startPrimary(service, 'parent-a', workId('1'));
  await startPrimary(service, 'parent-b', workId('2'));
  const event = watchEvent('shared-trigger');
  await createWatchReactor(service).react(event, command('shared-trigger:watch'));
  const requested = (await journal.readAll(0)).filter(
    (candidate) => candidate.eventType === 'orchestration.child-requested',
  );
  expect(requested).toHaveLength(2);
  expect(new Set(requested.map((candidate) => candidate.eventId)).size).toBe(2);

  await createWatchReactor({
    listWatchMatches: (eventType) => service.listWatchMatches(eventType),
    requestChild: (request, context) => service.requestChild(request, context),
    rejectCausalActivation: (request, context) => service.rejectCausalActivation(request, context),
    async isCausalRepeat() {
      return true;
    },
  }).react(watchEvent('shared-causal-trigger'), command('shared-causal-trigger:watch'));
  const rejected = (await journal.readAll(0)).filter(
    (candidate) => candidate.eventType === 'orchestration.causal-activation-rejected',
  );
  expect(rejected).toHaveLength(2);
  expect(new Set(rejected.map((candidate) => candidate.eventId)).size).toBe(2);
});

it('reconciles an unconsumed child completion during ordinary restarted advancement', async () => {
  const { activities, clock, definitions, ids, journal, service, work } = await fixture();
  const parents = await Promise.all([
    startPrimary(service, 'parent-1', workId('1')),
    startPrimary(service, 'parent-2', workId('2')),
  ]);
  for (const [index, parent] of parents.entries()) {
    const waiting = await service.acceptOutcome(
      {
        workflowInstanceId: parent.workflowInstanceId,
        activationId: parent.pendingActivation!.activationId,
        outcome: { kind: 'blocked' },
      },
      command(`block-parent-${index}`),
    );
    await service.waitForSignal(
      waiting.workflowInstanceId,
      { signalKind: signalName('orchestration.child-completed') },
      command(`wait-child-${index}`),
    );
  }
  const children = [];
  for (const [index, parent] of parents.entries()) {
    const child = await service.requestChild(
      {
        parentWorkflowInstanceId: parent.workflowInstanceId,
        watchId: 'review',
        triggerId: `trigger-${index}`,
        workflowName: workflowName('child'),
        causalCycleId: `cycle-${index}`,
        requestId: workflowInstanceId(
          `${parent.workflowInstanceId}:watch:review:trigger:trigger-${index}`,
        ),
        maxPerGroup: 1,
      },
      command(`request-child-${index}`),
    );
    if ('kind' in child) throw new Error('Expected child workflow to start');
    children.push(child);
  }
  const crashing = createOrchestrationService(failAllParentSignals(journal), work, definitions);
  for (const [index, child] of children.entries())
    await expect(
      crashing.acceptOutcome(
        {
          workflowInstanceId: child.workflowInstanceId,
          activationId: child.pendingActivation!.activationId,
          outcome: { kind: 'done' },
        },
        command(`complete-child-${index}`),
      ),
    ).rejects.toThrow('injected handoff crash');
  expect(
    (await journal.readAll(0)).filter(
      (event) => event.eventType === 'orchestration.signal-accepted',
    ),
  ).toHaveLength(0);

  const restarted = createOrchestrationService(journal, work, definitions);
  const advance = createAdvanceOnce(
    restarted,
    createExecutionService(
      journal,
      activities,
      { runnerPools: { standard: ['fake'] }, defaultRunnerPool: 'standard' },
      { clock, ids },
    ),
    createTestResourceServices(journal).resources,
    clock,
    { ids },
  );
  await advance({ workItemId: workId('1'), maxProgress: 1 });
  for (const [index, parent] of parents.entries())
    expect((await restarted.get(parent.workflowInstanceId))?.acceptedChildCompletionIds).toEqual([
      children[index]!.workflowInstanceId,
    ]);
  const accepted = (await journal.readAll(0)).filter(
    (event) => event.eventType === 'orchestration.signal-accepted',
  );
  const consumed = (await journal.readAll(0)).filter(
    (event) => event.eventType === 'orchestration.child-completion-consumed',
  );
  expect(accepted).toHaveLength(2);
  expect(consumed).toHaveLength(2);
  expect(new Set([...accepted, ...consumed].map((event) => event.eventId)).size).toBe(4);
});

function failWorkflowStartOnce(journal: EventJournal, id: string): EventJournal {
  return failAppendOnce(
    journal,
    (stream, events) =>
      isWorkflowInstanceStream(stream) &&
      stream.id === id &&
      events.some((event) => event.eventType === 'orchestration.instance-started'),
    'injected start crash',
  );
}

function failAllParentSignals(journal: EventJournal): EventJournal {
  return {
    async append(stream, sequence, events) {
      if (events.some((event) => event.eventType === 'orchestration.signal-accepted'))
        throw new Error('injected handoff crash');
      return journal.append(stream, sequence, events);
    },
    readStream: (stream) => journal.readStream(stream),
    readAll: (position, limit) => journal.readAll(position, limit),
  };
}

function failAppendOnce(
  journal: EventJournal,
  shouldFail: Parameters<EventJournal['append']> extends [infer Stream, number, infer Events]
    ? (stream: Stream, events: Events) => boolean
    : never,
  message: string,
): EventJournal {
  let armed = true;
  return {
    async append(stream, sequence, events) {
      if (armed && shouldFail(stream, events)) {
        armed = false;
        throw new Error(message);
      }
      return journal.append(stream, sequence, events);
    },
    readStream: (stream) => journal.readStream(stream),
    readAll: (position, limit) => journal.readAll(position, limit),
  };
}
