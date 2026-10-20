import * as eventing from '@atolis-hq/eventing';
import {
  EventProcessorHost,
  ProjectionRebuilder,
  applyProjectionBatch,
  applyProjectionEvent,
  createEventData,
  createProjectionProcessor,
  projectionConsumer,
  readCurrentProjection,
  type EventEnvelope,
  type StreamRef,
} from '@atolis-hq/eventing';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  createInMemoryProcessorRunSerialiser,
} from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

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
  const stream: StreamRef<'counter', 'subscription'> = { kind: 'counter', id: 'subscription' };
  await appendCountedEvent(journal, stream, 0, 'subscription-event');

  expect(subscription.consumer).toBe('projection:subscription-counts');
  expect(subscription.batchSize).toBe(100);
  expect(subscription.handle).toBeTypeOf('function');
  await applyProcessorBatch(subscription, await journal.readAll(0));
  expect((await projections.read<number>('subscription-counts', 'one'))?.value).toBe(1);
});

it('does not fold a duplicate projection batch twice', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: StreamRef<'counter', 'duplicate'> = { kind: 'counter', id: 'duplicate' };
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
  const stream: StreamRef<'counter', 'unselected'> = { kind: 'counter', id: 'unselected' };
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
  const stream: StreamRef<'counter', 'aborted'> = { kind: 'counter', id: 'aborted' };
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
  const stream: StreamRef<'counter', 'checkpoint'> = { kind: 'counter', id: 'checkpoint' };
  await appendCountedEvent(journal, stream, 0, 'checkpoint-event');
  const projections = new InMemoryProjectionStore();
  const checkpoints = new FailOnceCheckpointStore();
  const host = new EventProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
    new FakeClock(),
  );
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
  const stream: StreamRef<'counter', 'locking'> = { kind: 'counter', id: 'locking' };
  await appendCountedEvent(journal, stream, 0, 'locking-event');
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const serialiseRun = createInMemoryProcessorRunSerialiser();
  const host = new EventProcessorHost(journal, checkpoints, serialiseRun, new FakeClock());
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
  const stream: StreamRef<'counter', 'head'> = { kind: 'counter', id: 'head' };
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
  const stream: StreamRef<'counter', 'rebuild-race'> = { kind: 'counter', id: 'rebuild-race' };
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

it('reads a quiet key from the processor checkpoint, not by replaying history since the key last moved', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const definition = {
    name: 'keyed-counts',
    select: (event: EventEnvelope) => ({ key: event.stream.id }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
  const quiet: StreamRef<'counter', 'quiet'> = { kind: 'counter', id: 'quiet' };
  const busy: StreamRef<'counter', 'busy'> = { kind: 'counter', id: 'busy' };
  await appendCountedEvent(journal, quiet, 0, 'quiet-event');
  for (let index = 0; index < 300; index += 1)
    await appendCountedEvent(journal, busy, index, `busy-${index}`);
  const processor = createProjectionProcessor(definition, projections);
  await applyProcessorBatch(processor, await journal.readAll(0));
  await checkpoints.save(projectionConsumer(definition), 301);
  await appendCountedEvent(journal, quiet, 1, 'quiet-event-2');
  const readAll = vi.spyOn(journal, 'readAll');

  const value = await readCurrentProjection(
    { journal, projections, checkpoints },
    definition,
    'quiet',
  );

  expect(value).toBe(2);
  expect(readAll.mock.calls).toEqual([[301, 500]]);
});

it.each(['checkpoint', 'value'] as const)(
  'does not skip events the processor applies while a reader sits between its two reads (%s read)',
  async (raced) => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const store = new InMemoryProjectionStore();
    const checkpoints = new InMemoryCheckpointStore();
    const definition = projectionDefinition('racing-counts');
    const stream: StreamRef<'counter', 'racing'> = { kind: 'counter', id: 'racing' };
    for (let index = 0; index < 3; index += 1)
      await appendCountedEvent(journal, stream, index, `racing-${index}`);
    const events = await journal.readAll(0);
    const consumer = projectionConsumer(definition);
    await applyProjectionEvent(definition, store, 'one', events[0]!);
    await checkpoints.save(consumer, 1);
    // The processor writes the key, then saves its checkpoint, exactly as a pass does.
    const advance = async () => {
      for (const event of events.slice(1))
        await applyProjectionEvent(definition, store, 'one', event);
      await checkpoints.save(consumer, 3);
    };
    const racingCheckpoints = {
      load: async (name: string) => {
        if (raced === 'checkpoint') await advance();
        return checkpoints.load(name);
      },
    };
    const racingProjections = {
      ...store,
      read: async <Value>(namespace: string, key: string) => {
        if (raced === 'value') await advance();
        return store.read<Value>(namespace, key);
      },
    } as unknown as InMemoryProjectionStore;

    const value = await readCurrentProjection(
      { journal, projections: racingProjections, checkpoints: racingCheckpoints },
      definition,
      'one',
    );

    expect(value).toBe(3);
  },
);

it('resets the checkpoint before clearing the store when rebuilding', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const store = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const order: string[] = [];
  const reset = checkpoints.reset.bind(checkpoints);
  checkpoints.reset = async (consumer: string) => {
    order.push('reset');
    await reset(consumer);
  };
  const clear = store.clear.bind(store);
  store.clear = async (namespace?: string) => {
    order.push('clear');
    await clear(namespace);
  };
  const rebuilder = new ProjectionRebuilder(
    journal,
    store,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
  );

  await rebuilder.rebuild(projectionDefinition('rebuild-order'));

  expect(order).toEqual(['reset', 'clear']);
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
  stream: StreamRef,
  expectedSequence: number,
  eventId: string,
): Promise<void> {
  await journal.appendToStream(stream, expectedSequence, [
    createEventData({
      eventId,
      eventType: 'counted',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'cause',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
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
  events: readonly EventEnvelope[],
): Promise<void> {
  if (processor.mode === 'batch') throw new Error('Expected event projection processor');
  for (const event of events) {
    const selected = processor.select(event);
    if (selected !== null) await processor.handle(selected, event, new AbortController().signal);
  }
}
