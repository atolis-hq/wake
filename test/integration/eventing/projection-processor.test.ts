import { expect, it, vi } from 'vitest';
import * as eventing from '../../../src/eventing/index.js';
import {
  EventProcessorHost,
  ProjectionRebuilder,
  applyProjectionBatch,
  createProjectionProcessor,
  projectionConsumer,
} from '../../../src/eventing/index.js';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('does not expose the legacy centralized projection runner', () => {
  expect(eventing).not.toHaveProperty('ProjectionRunner');
});

it('names a projection subscription from its definition name', () => {
  expect(projectionConsumer(projectionDefinition('subscription-counts'))).toBe(
    'projection:subscription-counts',
  );
});

it('creates a bounded durable subscription that applies projection batches', async () => {
  const projections = new InMemoryProjectionStore();
  const definition = projectionDefinition('subscription-counts');
  const subscription = createProjectionProcessor(definition, projections);
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'subscription'> = { kind: 'counter', id: 'subscription' };
  await appendCountedEvent(journal, stream, 0, 'subscription-event');

  expect(subscription.consumer).toBe('projection:subscription-counts');
  expect(subscription.batchSize).toBe(100);
  expect(subscription.handle).toBeTypeOf('function');
  await applyProcessorBatch(subscription, await journal.readAll(0));
  expect((await projections.read<number>('subscription-counts', 'one'))?.value).toBe(1);
});

it('does not fold a duplicate projection batch twice', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'duplicate'> = { kind: 'counter', id: 'duplicate' };
  await appendCountedEvent(journal, stream, 0, 'duplicate-event');
  const projections = new InMemoryProjectionStore();
  const definition = projectionDefinition('duplicate-counts');
  const events = await journal.readAll(0);

  await applyProcessorBatch(createProjectionProcessor(definition, projections), events);
  await applyProcessorBatch(createProjectionProcessor(definition, projections), events);

  expect(await projections.read<number>('duplicate-counts', 'one')).toMatchObject({
    value: 1,
    lastGlobalPosition: 1,
  });
});

it('does not write when a projection does not select an event', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'unselected'> = { kind: 'counter', id: 'unselected' };
  await appendCountedEvent(journal, stream, 0, 'unselected-event');
  const projections = new InMemoryProjectionStore();

  await applyProjectionBatch(
    {
      name: 'unselected-counts',
      select: () => null,
      initial: () => 0,
      project: (previous: number) => previous + 1,
    },
    projections,
    await journal.readAll(0),
  );

  expect(await projections.list('unselected-counts')).toEqual([]);
});

it('does not mutate a projection batch when its signal is already aborted', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'aborted'> = { kind: 'counter', id: 'aborted' };
  await appendCountedEvent(journal, stream, 0, 'aborted-event');
  const projections = new InMemoryProjectionStore();
  const controller = new AbortController();
  controller.abort();

  await expect(
    applyProjectionBatch(
      projectionDefinition('aborted-counts'),
      projections,
      await journal.readAll(0),
      controller.signal,
    ),
  ).rejects.toThrow(/aborted/i);
  expect(await projections.list('aborted-counts')).toEqual([]);
});

it('replays after a checkpoint failure without folding the projection twice', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'checkpoint'> = { kind: 'counter', id: 'checkpoint' };
  await appendCountedEvent(journal, stream, 0, 'checkpoint-event');
  const projections = new InMemoryProjectionStore();
  const checkpoints = new FailOnceCheckpointStore();
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());
  const subscription = createProjectionProcessor(
    projectionDefinition('checkpoint-counts'),
    projections,
  );

  await expect(host.runOnce(subscription)).rejects.toThrow('injected checkpoint failure');
  await expect(host.runOnce(subscription)).resolves.toMatchObject({ eventCount: 1, checkpoint: 1 });
  expect((await projections.read<number>('checkpoint-counts', 'one'))?.value).toBe(1);
});

it('blocks a rebuild behind a same-consumer live pass while a sibling projection progresses', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'locking'> = { kind: 'counter', id: 'locking' };
  await appendCountedEvent(journal, stream, 0, 'locking-event');
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const serialiseRun = createInMemoryProcessorRunSerialiser();
  const host = new EventProcessorHost(journal, checkpoints, serialiseRun);
  const primary = projectionDefinition('locked-counts');
  const sibling = projectionDefinition('sibling-counts');
  const subscription = createProjectionProcessor(primary, projections);
  if (subscription.mode === 'batch') throw new Error('Expected event projection processor');
  const handlingStarted = deferred<void>();
  const releaseHandling = deferred<void>();
  const active = host.runOnce({
    ...subscription,
    handle: async (message, event, signal) => {
      handlingStarted.resolve();
      await releaseHandling.promise;
      await subscription.handle(message, event, signal);
    },
  });
  await handlingStarted.promise;
  const rebuilder = new ProjectionRebuilder(journal, projections, checkpoints, serialiseRun);
  const clearSpy = vi.spyOn(projections, 'clear');
  const resetSpy = vi.spyOn(checkpoints, 'reset');
  const rebuildingPrimary = rebuilder.rebuild(primary);

  await Promise.resolve();
  expect(clearSpy).not.toHaveBeenCalled();
  expect(resetSpy).not.toHaveBeenCalled();
  await expect(rebuilder.rebuild(sibling)).resolves.toBe(1);

  releaseHandling.resolve();
  await active;
  await expect(rebuildingPrimary).resolves.toBe(1);
  expect((await projections.read<number>('locked-counts', 'one'))?.value).toBe(1);
});

it('rebuilds bounded batches through the journal head and advances its checkpoint', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'head'> = { kind: 'counter', id: 'head' };
  for (let index = 0; index < 101; index++)
    await appendCountedEvent(journal, stream, index, `head-event-${index}`);
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const definition = projectionDefinition('head-counts');
  const rebuilder = new ProjectionRebuilder(
    journal,
    projections,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
  );

  await expect(rebuilder.rebuild(definition)).resolves.toBe(101);
  expect(await projections.read<number>('head-counts', 'one')).toMatchObject({
    value: 101,
    lastGlobalPosition: 101,
  });
  expect(await checkpoints.load('projection:head-counts')).toBe(101);
});

it('rebuilds through an append that lands after a short read snapshot', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'rebuild-race'> = { kind: 'counter', id: 'rebuild-race' };
  await appendCountedEvent(journal, stream, 0, 'rebuild-race-first');
  let appendedAfterSnapshot = false;
  const snapshottingJournal = {
    async readAll(afterGlobalPosition = 0, limit?: number) {
      const snapshot = await journal.readAll(afterGlobalPosition, limit);
      if (!appendedAfterSnapshot && snapshot.length > 0) {
        appendedAfterSnapshot = true;
        await appendCountedEvent(journal, stream, 1, 'rebuild-race-second');
      }
      return snapshot;
    },
  } as never;
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const definition = projectionDefinition('rebuild-race-counts');
  const rebuilder = new ProjectionRebuilder(
    snapshottingJournal,
    projections,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
  );

  await expect(rebuilder.rebuild(definition)).resolves.toBe(2);
  expect((await projections.read<number>('rebuild-race-counts', 'one'))?.value).toBe(2);
  expect(await checkpoints.load('projection:rebuild-race-counts')).toBe(
    await journal.latestGlobalPosition(),
  );
});

function projectionDefinition(name: string) {
  return {
    name,
    select: () => ({ key: 'one' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
}

async function appendCountedEvent(
  journal: InMemoryEventJournal,
  stream: EntityRef,
  expectedSequence: number,
  eventId: string,
): Promise<void> {
  await journal.append(stream, expectedSequence, [
    createEventDraft({
      eventId,
      eventType: 'counted',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'cause',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    }),
  ]);
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class FailOnceCheckpointStore extends InMemoryCheckpointStore {
  private failed = false;

  override async save(consumer: string, position: number): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('injected checkpoint failure');
    }
    await super.save(consumer, position);
  }
}

async function applyProcessorBatch(
  processor: ReturnType<typeof createProjectionProcessor>,
  events: readonly import('../../../src/kernel/index.js').EventEnvelope[],
): Promise<void> {
  if (processor.mode === 'batch') throw new Error('Expected event projection processor');
  for (const event of events) {
    const selected = processor.select(event);
    if (selected !== null) await processor.handle(selected, event, new AbortController().signal);
  }
}
