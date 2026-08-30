import { expect, it, vi } from 'vitest';
import {
  EventProcessorCategory,
  EventProcessorHost,
  EventProcessorReplayPolicy,
  createBatchEventProcessor,
  defineEventProcessor,
} from '../../../src/eventing/index.js';
import { createEventData, type EntityRef, type EventEnvelope } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemoryProcessorRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('requires an explicit run serialiser at construction', () => {
  expect(BatchProcessorHost).toBeTypeOf('function');
  // @ts-expect-error BatchProcessorHost requires an explicit serialiser.
  void new BatchProcessorHost(
    new InMemoryEventJournal(new FakeClock()),
    new InMemoryCheckpointStore(),
  );
});

it('advances independent named consumers through the same journal facts', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 2);
  const checkpoints = new InMemoryCheckpointStore();
  const host = new BatchProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());
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
  const host = new BatchProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

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
    const host = new BatchProcessorHost(
      new InMemoryEventJournal(new FakeClock()),
      new InMemoryCheckpointStore(),
      createInMemoryProcessorRunSerialiser(),
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
        new BatchProcessorHost(
          new InMemoryEventJournal(new FakeClock()),
          new InMemoryCheckpointStore(),
          createInMemoryProcessorRunSerialiser(),
          { fallbackMs },
        ),
    ).toThrow(/fallback/i);
  },
);

it("accepts Node's maximum timer delay and rejects a larger subscription fallback", () => {
  const createHost = (fallbackMs: number) =>
    new BatchProcessorHost(
      new InMemoryEventJournal(new FakeClock()),
      new InMemoryCheckpointStore(),
      createInMemoryProcessorRunSerialiser(),
      { fallbackMs },
    );

  expect(() => createHost(2_147_483_647)).not.toThrow();
  expect(() => createHost(2_147_483_648)).toThrow(/fallback/i);
});

it('rejects a non-function retry backoff', () => {
  expect(
    () =>
      new BatchProcessorHost(
        new InMemoryEventJournal(new FakeClock()),
        new InMemoryCheckpointStore(),
        createInMemoryProcessorRunSerialiser(),
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
  const host = new BatchProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());
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
  const host = new BatchProcessorHost(
    journal,
    checkpoints,
    createInMemoryProcessorRunSerialiser(),
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
  const serialise = createInMemoryProcessorRunSerialiser();
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
  const serialise = createInMemoryProcessorRunSerialiser();
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
  const host = new BatchProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
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
  const host = new BatchProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());
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

it('runs one bounded pass and returns its checkpoint and event count', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 3);
  const checkpoints = new InMemoryCheckpointStore();
  await checkpoints.save('bounded-pass', 1);
  const batches: number[][] = [];
  const host = new BatchProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

  const result = await host.runOnce({
    consumer: 'bounded-pass',
    batchSize: 1,
    handle: async (events) => {
      batches.push(events.map((event) => event.globalPosition));
    },
  });

  expect(batches).toEqual([[2]]);
  expect(result).toEqual({ checkpoint: 2, eventCount: 1, handledCount: 1 });
  expect(await checkpoints.load('bounded-pass')).toBe(2);
});

it('leaves the checkpoint unchanged when a pass handler fails', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const checkpoints = new InMemoryCheckpointStore();
  const host = new BatchProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

  await expect(
    host.runOnce({
      consumer: 'failed-pass',
      handle: async () => {
        throw new Error('injected handler failure');
      },
    }),
  ).rejects.toThrow('injected handler failure');
  expect(await checkpoints.load('failed-pass')).toBe(0);
});

it('serialises a same-consumer pass with the resident loop while another progresses', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const residentStarted = deferred<void>();
  const releaseResident = deferred<void>();
  let samePassEntered = false;
  let differentPassEntered = false;
  const host = new BatchProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
  );
  const resident = host.start([
    {
      consumer: 'same',
      handle: async () => {
        residentStarted.resolve();
        await releaseResident.promise;
      },
    },
  ]);

  await residentStarted.promise;
  const samePass = host.runOnce({
    consumer: 'same',
    handle: async () => {
      samePassEntered = true;
    },
  });
  const differentPass = await host.runOnce({
    consumer: 'different',
    handle: async () => {
      differentPassEntered = true;
    },
  });

  expect(differentPass).toEqual({ checkpoint: 1, eventCount: 1, handledCount: 1 });
  expect(differentPassEntered).toBe(true);
  expect(samePassEntered).toBe(false);
  releaseResident.resolve();
  await samePass;
  resident.abort();
  await resident.done;
});

it('recovers degraded health after a successful retry and stops cleanly on abort', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const retry = deferred<void>();
  const recovered = deferred<void>();
  let attempts = 0;
  const host = new BatchProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
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

it('runs through an explicit target without checkpointing past it', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 3);
  const checkpoints = new InMemoryCheckpointStore();
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());
  const handled: number[][] = [];

  const result = await host.runThrough(
    batchProcessor({
      consumer: 'bounded-through',
      batchSize: 3,
      handle: async (events) => {
        handled.push(events.map((event) => event.globalPosition));
      },
    }),
    2,
  );

  expect(handled).toEqual([[1, 2]]);
  expect(result).toEqual({ checkpoint: 2, eventCount: 2, handledCount: 2 });
  expect(await checkpoints.load('bounded-through')).toBe(2);
});

it('retries an initial checkpoint load failure without stopping the resident processor', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const retryObserved = deferred<void>();
  const handled = deferred<void>();
  const host = new EventProcessorHost(
    journal,
    new FailFirstLoadCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    { retryBackoff: async () => retryObserved.resolve() },
  );
  const run = host.start([
    batchProcessor({ consumer: 'load-retry', handle: async () => handled.resolve() }),
  ]);

  await retryObserved.promise;
  expect(host.health('load-retry')?.status).toBe('degraded');
  await handled.promise;
  run.abort();
  await run.done;
});

it('publishes a healthy head and bounds both error name and message', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await appendFacts(journal, 1);
  const retryObserved = deferred<void>();
  const holdRetry = deferred<void>();
  const failure = new Error('m'.repeat(1_100));
  failure.name = 'n'.repeat(1_100);
  const host = new EventProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    {
      retryBackoff: async () => {
        retryObserved.resolve();
        await holdRetry.promise;
      },
    },
  );
  const run = host.start([
    batchProcessor({
      consumer: 'bounded-error',
      handle: async () => {
        throw failure;
      },
    }),
  ]);

  await retryObserved.promise;
  expect(host.health('bounded-error')).toMatchObject({ head: 1, status: 'degraded' });
  expect(host.health('bounded-error')?.lastError).toMatchObject({
    name: 'n'.repeat(1_000),
    message: 'm'.repeat(1_000),
  });
  run.abort();
  holdRetry.resolve();
  await run.done;
});

it('retries a health head read failure without stopping its sibling', async () => {
  const source = new InMemoryEventJournal(new FakeClock());
  await appendFacts(source, 1);
  let failHead = true;
  const journal = {
    append: source.append.bind(source),
    readStream: source.readStream.bind(source),
    readAll: source.readAll.bind(source),
    waitForEventsAfter: source.waitForEventsAfter.bind(source),
    changeSignal: source.changeSignal,
    latestGlobalPosition: async () => {
      if (failHead) {
        failHead = false;
        throw new Error('injected head failure');
      }
      return source.latestGlobalPosition();
    },
  };
  const retryObserved = deferred<void>();
  const healthyHandled = deferred<void>();
  const host = new EventProcessorHost(
    journal,
    new InMemoryCheckpointStore(),
    createInMemoryProcessorRunSerialiser(),
    { retryBackoff: async () => retryObserved.resolve() },
  );
  const run = host.start([
    batchProcessor({ consumer: 'head-retry', handle: async () => {} }),
    batchProcessor({ consumer: 'healthy-sibling', handle: async () => healthyHandled.resolve() }),
  ]);

  await Promise.all([retryObserved.promise, healthyHandled.promise]);
  expect(host.health('head-retry')?.status).toBe('degraded');
  run.abort();
  await run.done;
});

it('does not invoke a batch handler or checkpoint after cancellation during a gated read', async () => {
  const source = new InMemoryEventJournal(new FakeClock());
  await appendFacts(source, 1);
  const readStarted = deferred<void>();
  const releaseRead = deferred<void>();
  const journal = {
    append: source.append.bind(source),
    readStream: source.readStream.bind(source),
    latestGlobalPosition: source.latestGlobalPosition.bind(source),
    waitForEventsAfter: source.waitForEventsAfter.bind(source),
    changeSignal: source.changeSignal,
    async readAll(afterGlobalPosition: number, limit?: number) {
      readStarted.resolve();
      await releaseRead.promise;
      return source.readAll(afterGlobalPosition, limit);
    },
  };
  const checkpoints = new InMemoryCheckpointStore();
  const controller = new AbortController();
  let handled = false;
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());
  const pass = host.runOnce(
    batchProcessor({
      consumer: 'gated-cancel',
      handle: async () => {
        handled = true;
      },
    }),
    controller.signal,
  );

  await readStarted.promise;
  controller.abort();
  releaseRead.resolve();
  await expect(pass).rejects.toThrow(/aborted/i);
  expect(handled).toBe(false);
  expect(await checkpoints.load('gated-cancel')).toBe(0);
});

async function appendFacts(journal: InMemoryEventJournal, count: number): Promise<void> {
  const stream: EntityRef<'subscription-test', 'one'> = { kind: 'subscription-test', id: 'one' };
  for (let index = 0; index < count; index += 1) {
    await journal.append(stream, index, [
      createEventData({
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

class FailFirstLoadCheckpointStore extends InMemoryCheckpointStore {
  private failed = false;

  override async load(consumer: string): Promise<number> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('injected load failure');
    }
    return super.load(consumer);
  }
}

class BatchProcessorHost {
  private readonly host: EventProcessorHost;

  constructor(
    journal: InMemoryEventJournal,
    checkpoints: InMemoryCheckpointStore,
    serialiseRun: ReturnType<typeof createInMemoryProcessorRunSerialiser>,
    options?: ConstructorParameters<typeof EventProcessorHost>[3],
  ) {
    this.host = new EventProcessorHost(journal, checkpoints, serialiseRun, options);
  }

  start(subscriptions: readonly BatchSubscription[], signal?: AbortSignal) {
    return this.host.start(subscriptions.map(batchProcessor), signal);
  }

  runOnce(subscription: BatchSubscription, signal?: AbortSignal) {
    return this.host.runOnce(batchProcessor(subscription), signal);
  }

  runThrough(subscription: BatchSubscription, target: number, signal?: AbortSignal) {
    return this.host.runThrough(batchProcessor(subscription), target, signal);
  }

  health(consumer: string) {
    return this.host.health(consumer);
  }
}

interface BatchSubscription {
  readonly consumer: string;
  readonly batchSize?: number;
  readonly handle: (events: readonly EventEnvelope[]) => Promise<void>;
}

function batchProcessor(subscription: BatchSubscription) {
  return createBatchEventProcessor({
    consumer: subscription.consumer,
    name: subscription.consumer,
    owner: 'test',
    category: EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    ...(subscription.batchSize === undefined ? {} : { batchSize: subscription.batchSize }),
    handle: (events) => subscription.handle(events),
  });
}

const typeSafeProcessor = defineEventProcessor({
  consumer: 'typed',
  name: 'typed',
  owner: 'test',
  category: EventProcessorCategory.Reactor,
  replayPolicy: EventProcessorReplayPolicy.Idempotent,
  select: () => 'message',
  handle: async (message: string) => {
    void message;
  },
});
void typeSafeProcessor;

const unregisteredMismatch = {
  consumer: 'unregistered-mismatch',
  name: 'unregistered-mismatch',
  owner: 'test',
  category: EventProcessorCategory.Reactor,
  replayPolicy: EventProcessorReplayPolicy.Idempotent,
  select: () => 'message',
  handle: async (message: number) => {
    void message;
  },
};

// @ts-expect-error Hosts accept only factory-registered processors.
const rejectedUnregisteredProcessor: Parameters<EventProcessorHost['runOnce']>[0] =
  unregisteredMismatch;
void rejectedUnregisteredProcessor;

defineEventProcessor({
  consumer: 'mismatch',
  name: 'mismatch',
  owner: 'test',
  category: EventProcessorCategory.Reactor,
  replayPolicy: EventProcessorReplayPolicy.Idempotent,
  // @ts-expect-error Selector and handler message types must agree.
  select: () => 'message',
  handle: async (message: number) => {
    void message;
  },
});
