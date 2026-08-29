import { expect, it } from 'vitest';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  DurableSubscriptionHost,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemorySubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('advances independent named consumers through the same journal facts', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 2);
  const checkpoints = new InMemoryCheckpointStore();
  const host = new DurableSubscriptionHost(
    journal,
    checkpoints,
    createInMemorySubscriptionRunSerialiser(),
  );
  const first = deferred<void>();
  const second = deferred<void>();
  const run = host.start([
    { consumer: 'first', handle: async () => first.resolve() },
    { consumer: 'second', handle: async () => second.resolve() },
  ]);

  await Promise.all([first.promise, second.promise]);
  run.abort();
  await run.done;

  expect(await checkpoints.load('first')).toBe(2);
  expect(await checkpoints.load('second')).toBe(2);
});

it('does not let a slow or failing consumer stall a healthy sibling', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const slowStarted = deferred<void>();
  const releaseSlow = deferred<void>();
  const healthyHandled = deferred<void>();
  const retryObserved = deferred<void>();
  const releaseRetry = deferred<void>();
  let failures = 0;
  const host = new DurableSubscriptionHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemorySubscriptionRunSerialiser(),
    {
      retryBackoff: async () => {
        retryObserved.resolve();
        await releaseRetry.promise;
      },
    },
  );
  const run = host.start([
    {
      consumer: 'slow',
      handle: async () => {
        slowStarted.resolve();
        await releaseSlow.promise;
      },
    },
    {
      consumer: 'failing',
      handle: async () => {
        failures += 1;
        if (failures === 1) throw new Error('injected failure');
      },
    },
    { consumer: 'healthy', handle: async () => healthyHandled.resolve() },
  ]);

  await Promise.all([slowStarted.promise, healthyHandled.promise, retryObserved.promise]);
  expect(host.health('failing')?.status).toBe('degraded');
  releaseSlow.resolve();
  run.abort();
  releaseRetry.resolve();
  await run.done;
});

it('reads a backlog in bounded batches and checkpoints only after handling each batch', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 3);
  const checkpoints = new InMemoryCheckpointStore();
  const firstBatch = deferred<void>();
  const releaseFirstBatch = deferred<void>();
  const batches: number[] = [];
  const host = new DurableSubscriptionHost(
    journal,
    checkpoints,
    createInMemorySubscriptionRunSerialiser(),
  );
  const run = host.start([
    {
      consumer: 'bounded',
      batchSize: 2,
      handle: async (events) => {
        batches.push(events.length);
        if (batches.length === 1) {
          firstBatch.resolve();
          await releaseFirstBatch.promise;
        }
      },
    },
  ]);

  await firstBatch.promise;
  expect(await checkpoints.load('bounded')).toBe(0);
  releaseFirstBatch.resolve();
  await eventually(() => checkpoints.load('bounded'), 3);
  run.abort();
  await run.done;

  expect(batches).toEqual([2, 1]);
});

it('recovers degraded health after a successful retry and stops cleanly on abort', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const retry = deferred<void>();
  const recovered = deferred<void>();
  let attempts = 0;
  const host = new DurableSubscriptionHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemorySubscriptionRunSerialiser(),
    { retryBackoff: async () => retry.resolve() },
  );
  const run = host.start([
    {
      consumer: 'recovering',
      handle: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('try again');
        recovered.resolve();
      },
    },
  ]);

  await retry.promise;
  await recovered.promise;
  await eventually(() => Promise.resolve(host.health('recovering')?.status), 'healthy');
  expect(host.health('recovering')).toMatchObject({
    status: 'healthy',
    consecutiveFailures: 0,
    checkpoint: 1,
  });
  run.abort();
  await expect(run.done).resolves.toBeUndefined();
  expect(host.health('recovering')?.status).toBe('stopped');
});

async function appendFacts(journal: InMemoryEventJournal, count: number): Promise<void> {
  const stream: EntityRef<'subscription-test', 'one'> = { kind: 'subscription-test', id: 'one' };
  for (let index = 0; index < count; index += 1) {
    await journal.append(stream, index, [
      createEventDraft({
        eventId: `subscription-test-${index}`,
        eventType: 'subscription-test.recorded',
        occurredAt: '2026-08-29T12:00:00.000Z',
        correlationId: 'correlation',
        causationId: 'causation',
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream,
        payload: {},
      }),
    ]);
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function eventually<Value>(read: () => Promise<Value>, expected: Value): Promise<void> {
  while ((await read()) !== expected) await Promise.resolve();
}
