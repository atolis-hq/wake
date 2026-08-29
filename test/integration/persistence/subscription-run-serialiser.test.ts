import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  DurableSubscriptionHost,
  FileCheckpointStore,
  InMemoryEventJournal,
  createFileSubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('excludes the same consumer across hosts for load, handling, and checkpointing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-subscription-serialiser-'));
  try {
    const journal = new InMemoryEventJournal(new FakeClock());
    await appendFact(journal);
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let secondHandled = false;
    const firstCheckpoints = new NotifyingFileCheckpointStore(root);
    const first = new DurableSubscriptionHost(
      journal,
      firstCheckpoints,
      createFileSubscriptionRunSerialiser(root),
    );
    const second = new DurableSubscriptionHost(
      journal,
      new FileCheckpointStore(root),
      createFileSubscriptionRunSerialiser(root),
    );
    const firstRun = first.start([
      {
        consumer: 'shared',
        handle: async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      },
    ]);
    await firstStarted.promise;
    const secondRun = second.start([
      {
        consumer: 'shared',
        handle: async () => {
          secondHandled = true;
        },
      },
    ]);

    expect(secondHandled).toBe(false);
    releaseFirst.resolve();
    await firstCheckpoints.saved;
    expect(secondHandled).toBe(false);
    firstRun.abort();
    secondRun.abort();
    await Promise.all([firstRun.done, secondRun.done]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('allows distinct consumers to progress concurrently across file-backed hosts', async () => {
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
        consumer: 'first',
        handle: async () => {
          firstStarted.resolve();
          await release.promise;
        },
      },
    ]);
    const secondRun = second.start([
      {
        consumer: 'second',
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

    expect(first.health('first')?.status).toBe('stopped');
    expect(second.health('second')?.status).toBe('stopped');
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

class NotifyingFileCheckpointStore extends FileCheckpointStore {
  private savedResolve!: () => void;
  readonly saved = new Promise<void>((resolve) => {
    this.savedResolve = resolve;
  });

  override async save(consumer: string, position: number): Promise<void> {
    await super.save(consumer, position);
    this.savedResolve();
  }
}
