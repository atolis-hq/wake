import { expect, it, vi } from 'vitest';
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

it('does not start a subscription already aborted by its parent signal', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const checkpoints = new InMemoryCheckpointStore();
  const waitForEventsAfter = vi.spyOn(journal, 'waitForEventsAfter');
  const parent = new AbortController();
  parent.abort();
  let handled = false;
  const host = new DurableSubscriptionHost(
    journal,
    checkpoints,
    createInMemorySubscriptionRunSerialiser(),
  );

  const run = host.start(
    [
      {
        consumer: 'pre-aborted',
        handle: async () => {
          handled = true;
        },
      },
    ],
    parent.signal,
  );
  await run.done;

  expect(handled).toBe(false);
  expect(waitForEventsAfter).not.toHaveBeenCalled();
  expect(await checkpoints.load('pre-aborted')).toBe(0);
  expect(host.health('pre-aborted')?.status).toBe('stopped');
});

it.each([0, -1, Number.POSITIVE_INFINITY, 1.5, 10_001])(
  'rejects an invalid subscription batch size: %s',
  (batchSize) => {
    const host = new DurableSubscriptionHost(
      new InMemoryEventJournal(new FakeClock()),
      new InMemoryCheckpointStore(),
      createInMemorySubscriptionRunSerialiser(),
    );

    expect(() =>
      host.start([{ consumer: 'invalid-batch', batchSize, handle: async () => {} }]),
    ).toThrow(/batch size/i);
  },
);

it.each([0, -1, Number.POSITIVE_INFINITY, 1.5])(
  'rejects an invalid subscription fallback: %s',
  (fallbackMs) => {
    expect(
      () =>
        new DurableSubscriptionHost(
          new InMemoryEventJournal(new FakeClock()),
          new InMemoryCheckpointStore(),
          createInMemorySubscriptionRunSerialiser(),
          { fallbackMs },
        ),
    ).toThrow(/fallback/i);
  },
);

it('rejects a non-function retry backoff', () => {
  expect(
    () =>
      new DurableSubscriptionHost(
        new InMemoryEventJournal(new FakeClock()),
        new InMemoryCheckpointStore(),
        createInMemorySubscriptionRunSerialiser(),
        { retryBackoff: 0 as never },
      ),
  ).toThrow(/retry backoff/i);
});

it("reads only each named consumer's own unread facts", async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 3);
  const checkpoints = new InMemoryCheckpointStore();
  await checkpoints.save('first', 1);
  await checkpoints.save('second', 2);
  const firstHandled = deferred<void>();
  const secondHandled = deferred<void>();
  const firstBatches: number[][] = [];
  const secondBatches: number[][] = [];
  const host = new DurableSubscriptionHost(
    journal,
    checkpoints,
    createInMemorySubscriptionRunSerialiser(),
  );
  const run = host.start([
    {
      consumer: 'first',
      handle: async (events) => {
        firstBatches.push(events.map((event) => event.globalPosition));
        firstHandled.resolve();
      },
    },
    {
      consumer: 'second',
      handle: async (events) => {
        secondBatches.push(events.map((event) => event.globalPosition));
        secondHandled.resolve();
      },
    },
  ]);

  await Promise.all([firstHandled.promise, secondHandled.promise]);
  run.abort();
  await run.done;

  expect(firstBatches).toEqual([[2, 3]]);
  expect(secondBatches).toEqual([[3]]);
  expect(await checkpoints.load('first')).toBe(3);
  expect(await checkpoints.load('second')).toBe(3);
});

it('replays an uncheckpointed handler batch after a checkpoint failure', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const checkpoints = new FailOnceCheckpointStore();
  const retryObserved = deferred<void>();
  const releaseRetry = deferred<void>();
  const replayed = deferred<void>();
  const durableEffects = new Set<string>();
  let attempts = 0;
  const host = new DurableSubscriptionHost(
    journal,
    checkpoints,
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
      consumer: 'checkpoint-failure',
      handle: async (events) => {
        attempts += 1;
        for (const event of events) durableEffects.add(event.eventId);
        if (attempts === 2) replayed.resolve();
      },
    },
  ]);

  await retryObserved.promise;
  expect(await checkpoints.load('checkpoint-failure')).toBe(0);
  expect(attempts).toBe(1);
  expect(durableEffects).toEqual(new Set(['subscription-test-0']));
  releaseRetry.resolve();
  await replayed.promise;
  await checkpoints.saved;
  run.abort();
  await run.done;

  expect(attempts).toBe(2);
  expect(durableEffects).toEqual(new Set(['subscription-test-0']));
  expect(await checkpoints.load('checkpoint-failure')).toBe(1);
});

it('serialises equal in-memory consumer keys', async () => {
  const serialise = createInMemorySubscriptionRunSerialiser();
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondStarted = deferred<void>();
  let secondEntered = false;
  const signal = new AbortController().signal;
  const first = serialise('equal', signal, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;
  const second = serialise('equal', signal, async () => {
    secondEntered = true;
    secondStarted.resolve();
  });

  await Promise.resolve();
  expect(secondEntered).toBe(false);
  releaseFirst.resolve();
  await secondStarted.promise;
  await Promise.all([first, second]);
});

it('allows distinct in-memory consumer keys to progress concurrently', async () => {
  const serialise = createInMemorySubscriptionRunSerialiser();
  const firstStarted = deferred<void>();
  const secondStarted = deferred<void>();
  const release = deferred<void>();
  const signal = new AbortController().signal;
  let firstEntered = false;
  let secondEntered = false;
  const first = serialise('first', signal, async () => {
    firstEntered = true;
    firstStarted.resolve();
    await release.promise;
  });
  const second = serialise('second', signal, async () => {
    secondEntered = true;
    secondStarted.resolve();
    await release.promise;
  });

  await Promise.all([firstStarted.promise, secondStarted.promise]);
  expect([firstEntered, secondEntered]).toEqual([true, true]);
  release.resolve();
  await Promise.all([first, second]);
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

class FailOnceCheckpointStore extends InMemoryCheckpointStore {
  private failed = false;
  private savedResolve!: () => void;
  readonly saved = new Promise<void>((resolve) => {
    this.savedResolve = resolve;
  });

  override async save(consumer: string, position: number): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('injected checkpoint failure');
    }
    await super.save(consumer, position);
    this.savedResolve();
  }
}
