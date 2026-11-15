import { correlationId, createEventData, EventProcessorHost } from '@atolis-hq/eventing';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityName, ActivityRegistry } from '../../../src/activities/index.js';
import { boardProjection } from '../../../src/bootstrap/board-projection.js';
import {
  compileWorkflow,
  createObservedStateReactor,
  createOrchestrationService,
  OrchestrationEventType,
  orchestrationGroupId,
  workflowInstanceId,
  workflowName,
} from '../../../src/orchestration/index.js';
import { auditFacts, presentWorkflowInstance } from '../../../src/surfaces/index.js';
import { createWorkService } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { workId } from '../../support/identities.js';

const stream = { kind: 'dependency', id: 'empty' };
const context = (commandId: string) => ({
  commandId,
  correlationId: correlationId('observed'),
  occurredAt: '2026-11-15T18:31:00Z',
  actor: { kind: 'system' as const, id: 'test' },
});

async function setup(configured = true) {
  const journal = new InMemoryEventJournal(new FakeClock());
  const work = createWorkService(journal);
  const id = workId('observed');
  await work.create({ workItemId: id, objective: 'reconsider state' }, context('create'));
  const registry = new ActivityRegistry();
  registry.register({
    name: activityName('check'),
    inputSchema: z.object({ value: z.number() }),
    outcomeSchema: z.object({ kind: z.enum(['done', 'blocked']) }),
    outcomeKinds: ['done', 'blocked'],
    resources: [],
    executionKind: 'deterministic',
    handler: {
      async execute() {
        return { kind: 'done' as const };
      },
    },
  });
  const definition = compileWorkflow(
    'default',
    {
      stages: {
        check: {
          activity: 'check',
          with: { value: 42 },
          requiresApproval: false,
          on: {
            done: { then: 'done' },
            ...(configured ? { blocked: { then: 'await-human' } } : {}),
          },
        },
      },
    },
    registry,
  );
  const service = createOrchestrationService(journal, work, { default: definition });
  const instance = await service.start(
    {
      workItemId: id,
      workflowInstanceId: workflowInstanceId('observed'),
      workflowName: workflowName('default'),
      orchestrationGroupId: orchestrationGroupId('observed'),
    },
    context('start'),
  );
  const block = async (observed = true) => {
    const state = (await service.get(instance.workflowInstanceId))!;
    await service.acceptOutcome(
      {
        workflowInstanceId: instance.workflowInstanceId,
        activationId: state.pendingActivation!.activationId,
        outcome: {
          kind: 'blocked',
          ...(observed
            ? { observed: [{ stream, version: (await journal.readStream(stream)).length }] }
            : {}),
        },
      },
      context(`block-${state.pendingActivation!.ordinal}`),
    );
  };
  const append = async (commandId: string, cause = commandId) =>
    (
      await journal.appendToStream(stream, (await journal.readStream(stream)).length, [
        createEventData({
          eventId: commandId,
          eventType: 'dependency.changed',
          ...context(commandId),
          causationId: cause,
          source: { kind: 'internal', id: 'test' },
          payload: {},
        }),
      ])
    )[0]!;
  const react = async () => {
    const events = await journal.readAll(0);
    await service.retryObservedState(events.at(-1)!);
  };
  return {
    journal,
    service,
    instance,
    block,
    append,
    react,
    get: () => service.get(instance.workflowInstanceId),
  };
}

it.each([true, false])(
  'retries an empty stream on its first event, including an unconfigured block (%s)',
  async (configured) => {
    const world = await setup(configured);
    await world.block();
    await world.react();
    expect((await world.get())?.pendingActivation?.ordinal).toBe(1);
    const trigger = await world.append('first');
    await world.service.retryObservedState(trigger);
    await world.service.retryObservedState(trigger);
    expect(await world.get()).toMatchObject({
      status: 'active',
      pendingActivation: { ordinal: 2, input: { value: 42 } },
      observedRetry: { count: 1, rootActivationId: 'observed:activity:1' },
    });
    await world.block();
    await world.service.retryObservedState(trigger);
    expect((await world.get())?.pendingActivation?.ordinal).toBe(2);
  },
);

it('catches an advance between the read and wait-start and ignores the activity own audit writes', async () => {
  const world = await setup();
  const pending = world.instance.pendingActivation!;
  await world.append('audit', pending.activationId);
  await world.service.acceptOutcome(
    {
      workflowInstanceId: world.instance.workflowInstanceId,
      activationId: pending.activationId,
      outcome: { kind: 'blocked', observed: [{ stream, version: 0 }] },
    },
    context('block'),
  );
  await world.react();
  expect((await world.get())?.pendingActivation?.ordinal).toBe(1);
  await world.append('state');
  await world.react();
  expect((await world.get())?.pendingActivation?.ordinal).toBe(2);
});

it('keeps legacy and subsequent human blocks parked', async () => {
  const world = await setup();
  await world.block();
  await world.append('change');
  await world.react();
  await world.block(false);
  await world.append('another');
  await world.react();
  expect((await world.get())?.pendingActivation?.ordinal).toBe(2);
});

it('allows five retries in the original chain and records exhaustion exactly once', async () => {
  const world = await setup();
  for (let index = 0; index < 6; index++) {
    await world.block();
    await world.append(`change-${index}`);
    await world.react();
  }
  await world.react();
  expect(await world.get()).toMatchObject({
    status: 'waiting',
    observedRetry: { count: 5, exhausted: true },
    pendingActivation: { ordinal: 6 },
  });
  const recorded = (await world.journal.readAll(0)).filter(
    (event) => event.event.eventType === OrchestrationEventType.ObservedStateRetryRecorded,
  );
  expect(recorded).toHaveLength(6);
  expect(createObservedStateReactor(world.service).consumer).toBe(
    'reactor:orchestration.observed-state',
  );
});

it('exposes the pending condition and durable exhaustion in workflow, board and audit views', async () => {
  const world = await setup();
  await world.block();
  const state = (await world.get())!;
  expect(presentWorkflowInstance(state).retryCondition).toBe(
    'blocked, will retry when dependency:empty change',
  );
  const facts = await auditFacts(world.journal, state.workItemId);
  expect(facts.at(-1)?.retryCondition).toBe('blocked, will retry when dependency:empty change');
  const board = (await world.journal.readAll(0)).reduce(
    (view, event) => boardProjection.project(view, event),
    boardProjection.initial('global'),
  );
  expect(board.cards[state.workItemId]?.retryCondition).toBe(
    'blocked, will retry when dependency:empty change',
  );
  for (let index = 0; index < 6; index++) {
    if (index > 0) await world.block();
    await world.append(`change-${index}`);
    await world.react();
  }
  const exhausted = (await world.get())!;
  expect(presentWorkflowInstance(exhausted).retryCondition).toContain('retries exhausted');
  expect((await auditFacts(world.journal, state.workItemId)).at(-1)?.retryCondition).toContain(
    'retries exhausted',
  );
});

it('does not reuse a consumed advance when a retry returns the same stale read versions', async () => {
  const world = await setup();
  await world.block();
  await world.append('first');
  await world.react();
  const retried = (await world.get())!;
  await world.service.acceptOutcome(
    {
      workflowInstanceId: retried.workflowInstanceId,
      activationId: retried.pendingActivation!.activationId,
      outcome: { kind: 'blocked', observed: [{ stream, version: 0 }] },
    },
    context('stale-read'),
  );
  await world.react();
  expect((await world.get())?.pendingActivation?.ordinal).toBe(2);
  await world.append('second');
  await world.react();
  expect((await world.get())?.pendingActivation?.ordinal).toBe(3);
});

it('keeps the reactor dormant until an observed wait starts and bootstraps again after restart', async () => {
  const world = await setup();
  let reads = 0;
  const port = {
    async retryObservedState() {
      reads++;
      return false;
    },
  };
  const reactor = createObservedStateReactor(port);
  const host = new EventProcessorHost(
    world.journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );
  await world.append('unrelated');
  await host.runOnce(reactor);
  await world.append('another');
  await host.runOnce(reactor);
  expect(reads).toBe(1);
  await world.block();
  await host.runOnce(reactor);
  expect(reads).toBe(2);
  await world.append('restart');
  await host.runOnce(createObservedStateReactor(port));
  expect(reads).toBe(3);
});
