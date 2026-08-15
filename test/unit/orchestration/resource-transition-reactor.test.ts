import { expect, it } from 'vitest';
import { ActivityEventType } from '../../../src/activities/index.js';
import {
  createEventDraft,
  eventId,
  type CheckpointStore,
  type CommandContext,
  type EntityRef,
} from '../../../src/kernel/index.js';
import {
  createResourceTransitionReactor,
  OrchestrationEventType,
  TransitionTargetKind,
  workflowInstanceId,
  workflowInstanceStream,
  type CompiledResourceTransition,
  type ResourceTransitionEvidence,
} from '../../../src/orchestration/index.js';
import { workItemId } from '../../../src/work/index.js';
import { InMemoryCheckpointStore, InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';
import { eventEnvelope } from '../../support/event-envelope.js';

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

function evidence(
  resolve: ResourceTransitionEvidence['resolve'],
): ResourceTransitionEvidence {
  return { triggers: [ActivityEventType.PrStateChanged], resolve };
}

function mergedFact(id = 'merged-1') {
  return {
    ...eventEnvelope(ActivityEventType.PrStateChanged, { state: 'merged' }, stream),
    eventId: eventId(id),
  };
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
  const waitStarted = {
    ...eventEnvelope(
      OrchestrationEventType.SignalWaitStarted,
      {
        signalKind: 'orchestration.resource-transition',
        resourceTransitions: [transition],
      },
      workflowInstanceStream(match.workflowInstanceId),
    ),
    eventId: eventId('wait-started-1'),
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

it('moves its checkpoint once after each event in journal order', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'event-1',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'cause-1',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { state: 'merged' },
    }),
    createEventDraft({
      eventId: 'event-2',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:01:00.000Z',
      correlationId: 'correlation-2',
      causationId: 'cause-2',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
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
    journal,
    trackingCheckpoints,
  );

  await expect(reactor.runOnce()).resolves.toBe(2);

  expect(saves).toEqual([1, 2]);
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(2);
});

it('does not advance after a failed reaction and reuses its command context on replay', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'event-fail-react',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-fail',
      causationId: 'cause-fail',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
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
    journal,
    checkpoints,
  );

  await expect(reactor.runOnce()).rejects.toThrow('injected transition failure');
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(0);
  await expect(reactor.runOnce()).resolves.toBe(1);

  expect(commandIds).toEqual([
    'event-fail-react:resource-transition',
    'event-fail-react:resource-transition',
  ]);
  expect(await checkpoints.load('reactor:orchestration.resource-transition')).toBe(1);
});

it('does not advance after a checkpoint failure and reuses its command context on replay', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const durable = new InMemoryCheckpointStore();
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'event-fail-checkpoint',
      eventType: ActivityEventType.PrStateChanged,
      occurredAt: '2026-08-15T12:00:00.000Z',
      correlationId: 'correlation-checkpoint',
      causationId: 'cause-checkpoint',
      actor: { kind: 'integration', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
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
    journal,
    checkpoints,
  );

  await expect(reactor.runOnce()).rejects.toThrow('injected checkpoint failure');
  expect(await durable.load('reactor:orchestration.resource-transition')).toBe(0);
  await expect(reactor.runOnce()).resolves.toBe(1);

  expect(commandIds).toEqual([
    'event-fail-checkpoint:resource-transition',
    'event-fail-checkpoint:resource-transition',
  ]);
  expect(await durable.load('reactor:orchestration.resource-transition')).toBe(1);
});
