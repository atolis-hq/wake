import {
  createEventData,
  eventId,
  EventProcessorHost,
  type CheckpointStore,
  type CommandContext,
} from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { ActivityEventType } from '../../../src/activities/index.js';
import { type EntityRef } from '../../../src/kernel/index.js';
import {
  createResourceTransitionReactor,
  OrchestrationEventType,
  TransitionTargetKind,
  workflowInstanceId,
  workflowInstanceStream,
  type CompiledResourceTransition,
  type ResourceTransitionEvidence,
} from '../../../src/orchestration/index.js';
import {
  createInMemoryProcessorRunSerialiser,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src/persistence/index.js';
import { workItemId } from '../../../src/work/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';

it('exposes the stable resource-transition processor', () => {
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [];
      },
      async applyResourceTransition() {},
    },
    evidence(async () => null),
  );

  expect(reactor).toMatchObject({
    processor: {
      consumer: 'reactor:orchestration.resource-transition',
      name: 'resource-transition',
      owner: 'orchestration',
    },
  });
  expect(typeof reactor.react).toBe('function');
});

it('ignores unrelated facts through its processor selector', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'unrelated-fact',
      eventType: 'work.created',
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {},
    }),
  ]);
  let matched = 0;
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        matched += 1;
        return [];
      },
      async applyResourceTransition() {},
    },
    evidence(async () => null),
  );
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );

  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({
    eventCount: 1,
    handledCount: 0,
  });
  expect(matched).toBe(0);
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(1);
});

const stream: EntityRef<'test', 'resource-transition-reactor'> = {
  kind: 'test',
  id: 'resource-transition-reactor',
};
const transition: CompiledResourceTransition = {
  event: ActivityEventType.PrStateChanged,
  where: { state: 'merged' },
  target: { kind: TransitionTargetKind.Complete },
};
const match = {
  workflowInstanceId: workflowInstanceId('workflow-1'),
  workItemId: workItemId('work-00000000000000000000000001'),
  transitions: [transition],
};
const context: CommandContext = {
  commandId: 'resource-transition-react',
  correlationId: 'correlation-1' as never,
  occurredAt: '2026-08-15T12:00:00.000Z',
  actor: { kind: 'system', id: 'test' },
};

function evidence(resolve: ResourceTransitionEvidence['resolve']): ResourceTransitionEvidence {
  return { triggers: [ActivityEventType.PrStateChanged], resolve };
}

function mergedFact(id = 'merged-1') {
  const envelope = eventEnvelope(ActivityEventType.PrStateChanged, { state: 'merged' }, stream);
  return { ...envelope, event: { ...envelope.event, eventId: eventId(id) } };
}

it('applies an evidence-resolved resource transition', async () => {
  const applied: unknown[][] = [];
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition(...input) {
        applied.push(input);
      },
    },
    evidence(async () => ({ transition, evidenceId: 'evidence-1' })),
  );

  await reactor.react(mergedFact(), context);

  expect(applied).toEqual([[match.workflowInstanceId, transition.target, 'evidence-1', context]]);
});

it('does not apply a resource transition when evidence declines it', async () => {
  let applied = false;
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition() {
        applied = true;
      },
    },
    evidence(async () => null),
  );

  await reactor.react(mergedFact(), context);

  expect(applied).toBe(false);
});

it('does not query orchestration or evidence for an irrelevant event', async () => {
  let matchingCalls = 0;
  let evidenceCalls = 0;
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        matchingCalls += 1;
        throw new Error('irrelevant events must not reach matching');
      },
      async applyResourceTransition() {},
    },
    evidence(async () => {
      evidenceCalls += 1;
      throw new Error('irrelevant events must not reach evidence');
    }),
  );
  const irrelevant = eventEnvelope('work.unrelated', {}, stream);

  await expect(reactor.react(irrelevant, context)).resolves.toBeUndefined();

  expect(matchingCalls).toBe(0);
  expect(evidenceCalls).toBe(0);
});

it('asks evidence to search history when a resource-transition wait starts', async () => {
  let receivedFact: unknown = 'not-called';
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition() {},
    },
    evidence(async (input) => {
      receivedFact = input.fact;
      return null;
    }),
  );
  const envelope = eventEnvelope(
    OrchestrationEventType.SignalWaitStarted,
    {
      signalKind: 'orchestration.resource-transition',
      resourceTransitions: [transition],
    },
    workflowInstanceStream(match.workflowInstanceId),
  );
  const waitStarted = {
    ...envelope,
    event: { ...envelope.event, eventId: eventId('wait-started-1') },
  };

  await reactor.react(waitStarted, context);

  expect(receivedFact).toBeUndefined();
});

it('passes a live fact to the evidence policy', async () => {
  let receivedFact: unknown;
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition() {},
    },
    evidence(async (input) => {
      receivedFact = input.fact;
      return null;
    }),
  );
  const fact = mergedFact();

  await reactor.react(fact, context);

  expect(receivedFact).toBe(fact);
});

it('delegates bounded checkpoint progress to the event processor host', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-1',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { state: 'merged' },
    }),
    createEventData({
      eventId: 'event-2',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:01:00.000Z',
      correlationId: 'correlation-2',
      causationId: 'cause-2',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { state: 'merged' },
    }),
  ]);
  const saves: number[] = [];
  const trackingCheckpoints: CheckpointStore = {
    load: (consumer) => checkpoints.load(consumer),
    async save(consumer, position) {
      saves.push(position);
      await checkpoints.save(consumer, position);
    },
    reset: (consumer) => checkpoints.reset(consumer),
  };
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [];
      },
      async applyResourceTransition() {},
    },
    evidence(async () => null),
  );
  const host = new EventProcessorHost(
    journal,
    trackingCheckpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );

  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({ eventCount: 2 });

  expect(saves).toEqual([2]);
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(2);
});

it('catches up more than one batch through the eventing barrier', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: 101 }, (_, index) =>
      createEventData({
        eventId: `event-${index + 1}`,
        eventType: ActivityEventType.PrStateChanged,
        occurredAt: '2026-08-15T12:00:00.000Z',
        correlationId: 'correlation-1',
        causationId: `cause-${index + 1}`,
        actor: { kind: 'integration', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload: { state: 'merged' },
      }),
    ),
  );
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [];
      },
      async applyResourceTransition() {},
    },
    evidence(async () => null),
  );
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );

  await expect(host.runThrough(reactor.processor, 101)).resolves.toMatchObject({ eventCount: 101 });
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(101);
  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({ eventCount: 0 });
});

it('serializes an overlapping processor pass and catch-up barrier through checkpoint advancement', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const durable = new InMemoryCheckpointStore();
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-1',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { state: 'merged' },
    }),
    createEventData({
      eventId: 'event-2',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:01:00.000Z',
      correlationId: 'correlation-2',
      causationId: 'cause-2',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { state: 'merged' },
    }),
  ]);
  let firstSaveStarted!: () => void;
  const firstSave = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  let releaseFirstSave!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  let holdFirstSave = true;
  const checkpoints: CheckpointStore = {
    load: (consumer) => durable.load(consumer),
    async save(consumer, position) {
      if (holdFirstSave) {
        holdFirstSave = false;
        firstSaveStarted();
        await release;
      }
      await durable.save(consumer, position);
    },
    reset: (consumer) => durable.reset(consumer),
  };
  const applied: string[] = [];
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition(_id, _target, evidenceId) {
        applied.push(evidenceId);
      },
    },
    evidence(async ({ fact }) =>
      fact === undefined ? null : { transition, evidenceId: fact.event.eventId },
    ),
  );
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );

  const runnerBatch = host.runOnce(reactor.processor);
  await firstSave;
  const barrierCatchUp = host.runThrough(reactor.processor, 2);
  releaseFirstSave();

  await expect(runnerBatch).resolves.toMatchObject({ eventCount: 2 });
  await expect(barrierCatchUp).resolves.toMatchObject({ eventCount: 0 });
  expect(applied).toEqual(['event-1', 'event-2']);
  expect(await durable.load('reactor:orchestration.resource-transition')).toBe(2);
});

it('does not advance after a failed reaction and reuses its command context on replay', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-fail-react',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-fail',
      causationId: 'cause-fail',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { state: 'merged' },
    }),
  ]);
  let fail = true;
  const commandIds: string[] = [];
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition(_id, _target, _evidenceId, command) {
        commandIds.push(command.commandId);
        if (fail) {
          fail = false;
          throw new Error('injected transition failure');
        }
      },
    },
    evidence(async () => ({ transition, evidenceId: 'evidence-1' })),
  );
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );

  await expect(host.runOnce(reactor.processor)).rejects.toThrow('injected transition failure');
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(0);
  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({ eventCount: 1 });

  expect(commandIds).toEqual([
    'event-fail-react:resource-transition',
    'event-fail-react:resource-transition',
  ]);
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(1);
});

it('does not advance after a checkpoint failure and reuses its command context on replay', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const durable = new InMemoryCheckpointStore();
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-fail-checkpoint',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-checkpoint',
      causationId: 'cause-checkpoint',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { state: 'merged' },
    }),
  ]);
  let failSave = true;
  const checkpoints: CheckpointStore = {
    load: (consumer) => durable.load(consumer),
    async save(consumer, position) {
      if (failSave) {
        failSave = false;
        throw new Error('injected checkpoint failure');
      }
      await durable.save(consumer, position);
    },
    reset: (consumer) => durable.reset(consumer),
  };
  const commandIds: string[] = [];
  const reactor = createResourceTransitionReactor(
    {
      async listResourceTransitionMatches() {
        return [match];
      },
      async applyResourceTransition(_id, _target, _evidenceId, command) {
        commandIds.push(command.commandId);
      },
    },
    evidence(async () => ({ transition, evidenceId: 'evidence-1' })),
  );
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );

  await expect(host.runOnce(reactor.processor)).rejects.toThrow('injected checkpoint failure');
  expect(await durable.load('reactor:orchestration.resource-transition')).toBe(0);
  await expect(host.runOnce(reactor.processor)).resolves.toMatchObject({ eventCount: 1 });

  expect(commandIds).toEqual([
    'event-fail-checkpoint:resource-transition',
    'event-fail-checkpoint:resource-transition',
  ]);
  expect(await durable.load('reactor:orchestration.resource-transition')).toBe(1);
});
