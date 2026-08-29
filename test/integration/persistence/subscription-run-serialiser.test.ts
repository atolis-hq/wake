import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { activationSchedulerSubscriptionConsumer } from '../../../src/control-plane/index.js';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  DurableSubscriptionHost,
  FileCheckpointStore,
  InMemoryEventJournal,
  createFileSubscriptionRunSerialiser,
  type SubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

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
    const first = new DurableSubscriptionHost(
      journal,
      firstCheckpoints,
      createFileSubscriptionRunSerialiser(root),
    );
    const fileSerialise = createFileSubscriptionRunSerialiser(root);
    const secondSerialise: SubscriptionRunSerialiser = async (consumer, signal, operation) => {
      secondSerialiseStarted.resolve();
      return fileSerialise(consumer, signal, operation);
    };
    const second = new DurableSubscriptionHost(journal, secondCheckpoints, secondSerialise);
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
    const first = new DurableSubscriptionHost(
      journal,
      new FileCheckpointStore(root),
      createFileSubscriptionRunSerialiser(root),
    );
    const second = new DurableSubscriptionHost(
      journal,
      new FileCheckpointStore(root),
      createFileSubscriptionRunSerialiser(root),
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
      const serialise = createFileSubscriptionRunSerialiser(root);

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
    const serialise = createFileSubscriptionRunSerialiser(root);

    await expect(
      serialise('consumer-😀', new AbortController().signal, async () => 'handled'),
    ).resolves.toBe('handled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function appendFact(journal: InMemoryEventJournal): Promise<void> {
  const stream: EntityRef<'subscription-test', 'one'> = { kind: 'subscription-test', id: 'one' };
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'subscription-test',
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
