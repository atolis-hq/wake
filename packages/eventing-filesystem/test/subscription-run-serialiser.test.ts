import {
  EventProcessorCategory,
  EventProcessorHost,
  EventProcessorReplayPolicy,
  createBatchEventProcessor,
  createEventData,
  type StreamRef as EntityRef,
  type EventEnvelope,
  type ProcessorRunSerialiser,
} from '@atolis-hq/eventing';
import {
  FileCheckpointStore,
  createFileProcessorRunSerialiser,
} from '@atolis-hq/eventing-filesystem';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireFileLock } from '../src/file-lock.js';
import {
  encodeProcessorConsumer,
  processorRunRetryDelayMs,
} from '../src/file-processor-run-serialiser.js';
import { FakeClock } from './support/fake-clock.js';

const activationSchedulerSubscriptionConsumer = 'activation-scheduler';

it('uses a bounded exponential delay for repeated processor lock contention', () => {
  expect([1, 2, 3, 4, 5, 6, 7].map((contentions) => processorRunRetryDelayMs(contentions))).toEqual(
    [10, 20, 40, 80, 160, 250, 250],
  );
});

it('excludes the same consumer across hosts for load, handling, and checkpointing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-subscription-serialiser-'));
  try {
    const journal = new InMemoryEventJournal(new FakeClock());
    await appendFact(journal);
    const firstHandlerStarted = deferred<void>();
    const releaseFirstHandler = deferred<void>();
    const secondSerialiseStarted = deferred<void>();
    let secondHandled = false;
    const firstCheckpoints = new GatedFileCheckpointStore(root);
    const secondCheckpoints = new ObservingFileCheckpointStore(root);
    const first = new BatchProcessorHost(
      journal,
      firstCheckpoints,
      createFileProcessorRunSerialiser(root),
    );
    const fileSerialise = createFileProcessorRunSerialiser(root);
    const secondSerialise: ProcessorRunSerialiser = async (consumer, signal, operation) => {
      secondSerialiseStarted.resolve();
      return fileSerialise(consumer, signal, operation);
    };
    const second = new BatchProcessorHost(journal, secondCheckpoints, secondSerialise);
    const firstRun = first.start([
      {
        consumer: activationSchedulerSubscriptionConsumer,
        handle: async () => {
          firstHandlerStarted.resolve();
          await releaseFirstHandler.promise;
        },
      },
    ]);
    await firstCheckpoints.loadStarted.promise;
    const secondRun = second.start([
      {
        consumer: activationSchedulerSubscriptionConsumer,
        handle: async () => {
          secondHandled = true;
        },
      },
    ]);

    await secondSerialiseStarted.promise;
    expect(secondCheckpoints.loadCalls).toBe(0);
    firstCheckpoints.releaseLoad();
    await firstHandlerStarted.promise;
    expect(secondCheckpoints.loadCalls).toBe(0);
    releaseFirstHandler.resolve();
    await firstCheckpoints.saveStarted.promise;
    expect(secondCheckpoints.loadCalls).toBe(0);
    firstCheckpoints.releaseSave();
    await firstCheckpoints.saved;
    await secondCheckpoints.loadStarted.promise;
    expect(secondHandled).toBe(false);
    firstRun.abort();
    secondRun.abort();
    await Promise.all([firstRun.done, secondRun.done]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('allows legacy-colliding consumer names to progress concurrently across file-backed hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-subscription-serialiser-'));
  try {
    const journal = new InMemoryEventJournal(new FakeClock());
    await appendFact(journal);
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const release = deferred<void>();
    const first = new BatchProcessorHost(
      journal,
      new FileCheckpointStore(root),
      createFileProcessorRunSerialiser(root),
    );
    const second = new BatchProcessorHost(
      journal,
      new FileCheckpointStore(root),
      createFileProcessorRunSerialiser(root),
    );
    const firstRun = first.start([
      {
        consumer: 'a.b',
        handle: async () => {
          firstStarted.resolve();
          await release.promise;
        },
      },
    ]);
    const secondRun = second.start([
      {
        consumer: 'a~2Eb',
        handle: async () => {
          secondStarted.resolve();
          await release.promise;
        },
      },
    ]);

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    release.resolve();
    firstRun.abort();
    secondRun.abort();
    await Promise.all([firstRun.done, secondRun.done]);

    expect(first.health('a.b')?.status).toBe('stopped');
    expect(second.health('a~2Eb')?.status).toBe('stopped');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['\uD800', '\uD801'])(
  'rejects an ill-formed UTF-16 file lock consumer identity: %j',
  async (consumer) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-subscription-serialiser-'));
    try {
      const serialise = createFileProcessorRunSerialiser(root);

      await expect(
        serialise(consumer, new AbortController().signal, async () => undefined),
      ).rejects.toThrow(/well-formed UTF-16/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('accepts ordinary Unicode file lock consumer identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-subscription-serialiser-'));
  try {
    const serialise = createFileProcessorRunSerialiser(root);

    await expect(
      serialise('consumer-😀', new AbortController().signal, async () => 'handled'),
    ).resolves.toBe('handled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the established subscription lock basename for cross-version exclusion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-processor-serialiser-'));
  try {
    const consumer = 'cross-version';
    const legacyLock = await acquireFileLock(
      join(root, 'locks', `subscription-${encodeProcessorConsumer(consumer)}.lock`),
      { staleAfterMs: 60_000, staleRequiresDeadProcess: true },
    );
    if (!legacyLock.acquired) throw new Error('Could not establish legacy lock');
    const serialise = createFileProcessorRunSerialiser(root);
    let entered = false;
    const pending = serialise(consumer, new AbortController().signal, async () => {
      entered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(entered).toBe(false);
    await legacyLock.release();
    await pending;
    expect(entered).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function appendFact(journal: InMemoryEventJournal): Promise<void> {
  const stream: EntityRef<'subscription-test', 'one'> = { kind: 'subscription-test', id: 'one' };
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'subscription-test',
      eventType: 'subscription-test.recorded',
      occurredAt: '2026-08-29T12:00:00.000Z',
      correlationId: 'correlation',
      causationId: 'causation',
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

class GatedFileCheckpointStore extends FileCheckpointStore {
  private loadRelease!: () => void;
  private saveRelease!: () => void;
  private loadCalls = 0;
  private savedResolve!: () => void;
  readonly loadStarted = deferred<void>();
  readonly saveStarted = deferred<void>();
  private readonly loadGate = new Promise<void>((resolve) => {
    this.loadRelease = resolve;
  });

  private readonly saveGate = new Promise<void>((resolve) => {
    this.saveRelease = resolve;
  });

  readonly saved = new Promise<void>((resolve) => {
    this.savedResolve = resolve;
  });

  override async load(consumer: string): Promise<number> {
    if (this.loadCalls++ === 0) {
      this.loadStarted.resolve();
      await this.loadGate;
    }
    return super.load(consumer);
  }

  override async save(consumer: string, position: number): Promise<void> {
    this.saveStarted.resolve();
    await this.saveGate;
    await super.save(consumer, position);
    this.savedResolve();
  }

  releaseLoad(): void {
    this.loadRelease();
  }

  releaseSave(): void {
    this.saveRelease();
  }
}

class ObservingFileCheckpointStore extends FileCheckpointStore {
  loadCalls = 0;
  readonly loadStarted = deferred<void>();

  override async load(consumer: string): Promise<number> {
    this.loadCalls += 1;
    this.loadStarted.resolve();
    return super.load(consumer);
  }
}

class BatchProcessorHost {
  private readonly host: EventProcessorHost;

  constructor(
    journal: InMemoryEventJournal,
    checkpoints: FileCheckpointStore,
    serialiseRun: ProcessorRunSerialiser,
  ) {
    this.host = new EventProcessorHost(journal, checkpoints, serialiseRun, new FakeClock());
  }

  start(subscriptions: readonly BatchSubscription[], signal?: AbortSignal) {
    return this.host.start(subscriptions.map(batchProcessor), signal);
  }

  health(consumer: string) {
    return this.host.health(consumer);
  }
}

interface BatchSubscription {
  readonly consumer: string;
  readonly handle: (events: readonly EventEnvelope[]) => Promise<void>;
}

function batchProcessor(subscription: BatchSubscription) {
  return createBatchEventProcessor({
    consumer: subscription.consumer,
    name: subscription.consumer,
    owner: 'test',
    category: EventProcessorCategory.Reactor,
    replayPolicy: EventProcessorReplayPolicy.Idempotent,
    handle: (events) => subscription.handle(events),
  });
}
