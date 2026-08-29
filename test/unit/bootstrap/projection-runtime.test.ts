import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import {
  createRuntimeProjectionSubscriptions,
  runtimeProjectionDefinitions,
} from '../../../src/bootstrap/index.js';
import { resolveWakePaths } from '../../../src/bootstrap/paths.js';
import { composePersistence } from '../../../src/bootstrap/persistence-composition.js';
import {
  createEventDraft,
  type EntityRef,
  type EventJournal,
  type ProjectionDefinition,
  type ProjectionStore,
} from '../../../src/kernel/index.js';
import {
  FileCheckpointStore,
  FileEventJournal,
  FileProjectionStore,
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  type SubscriptionRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('registers every runtime definition with its stable projection consumer', () => {
  const runtime = createRuntimeProjectionSubscriptions(
    new InMemoryEventJournal(new FakeClock()),
    new InMemoryProjectionStore(),
    new InMemoryCheckpointStore(),
  );

  expect(runtime.subscriptions.map(({ consumer }) => consumer)).toEqual(
    runtimeProjectionDefinitions.map(({ name }) => `projection:${name}`),
  );
  expect(new Set(runtime.subscriptions.map(({ consumer }) => consumer))).toHaveProperty(
    'size',
    runtimeProjectionDefinitions.length,
  );
});

it('catches up only the targeted projection before catching up its sibling', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  const primary = countedProjection('targeted-primary');
  const sibling = countedProjection('targeted-sibling');
  const runtime = createRuntimeProjectionSubscriptions(
    journal,
    new InMemoryProjectionStore(),
    checkpoints,
    undefined,
    [primary, sibling],
  );
  await appendCountedEvent(journal, 'targeted-event');

  await expect(runtime.catchUp(primary)).resolves.toBe(1);
  expect(await checkpoints.load('projection:targeted-primary')).toBe(1);
  expect(await checkpoints.load('projection:targeted-sibling')).toBe(0);
  await expect(runtime.catchUpOnce()).resolves.toBe(1);
  expect(await checkpoints.load('projection:targeted-sibling')).toBe(1);
});

it('skips already-caught-up projection consumers before acquiring their locks', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const serialisedConsumers: string[] = [];
  const runtime = createRuntimeProjectionSubscriptions(
    journal,
    new InMemoryProjectionStore(),
    new InMemoryCheckpointStore(),
    recordingSerialiser(serialisedConsumers),
    [countedProjection('caught-up-primary'), countedProjection('caught-up-sibling')],
  );
  await appendCountedEvent(journal, 'caught-up-event');
  await runtime.catchUpOnce();
  serialisedConsumers.length = 0;

  await expect(runtime.catchUpOnce()).resolves.toBe(0);

  expect(serialisedConsumers).toEqual([]);
});

it('drains a one-shot projection barrier through its observed head under one consumer lock', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  const serialisedConsumers: string[] = [];
  const runtime = createRuntimeProjectionSubscriptions(
    journal,
    new InMemoryProjectionStore(),
    checkpoints,
    recordingSerialiser(serialisedConsumers),
    [countedProjection('barrier-projection')],
  );
  await appendCountedEvents(journal, 'barrier-event', 101);

  await expect(runtime.catchUpOnce()).resolves.toBe(101);

  expect(await checkpoints.load('projection:barrier-projection')).toBe(101);
  expect(serialisedConsumers).toEqual(['projection:barrier-projection']);
});

it('rebuilds the registered projection when another definition has the same name', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const projections = new InMemoryProjectionStore();
  const registered = countedProjection('registered-projection');
  const runtime = createRuntimeProjectionSubscriptions(
    journal,
    projections,
    new InMemoryCheckpointStore(),
    undefined,
    [registered],
  );
  await appendCountedEvent(journal, 'registered-rebuild');

  await expect(
    runtime.rebuild({
      ...registered,
      select: () => null,
    }),
  ).resolves.toBe(1);
  expect(await projections.read<number>(registered.name, 'one')).toMatchObject({ value: 1 });
});

it('uses file locking for two fully injected projection runtimes at one data root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projection-serialiser-'));
  const clock = new FakeClock();
  const paths = resolveWakePaths(root);
  const definition = countedProjection('injected-file-projection');
  const firstWriteStarted = deferred<void>();
  const releaseFirstWrite = deferred<void>();
  let secondJournalReadStarted = false;
  const first = composePersistence(paths, clock, {
    journal: new FileEventJournal(paths.dataRoot, clock),
    projections: new FileProjectionStore(paths.dataRoot),
    checkpoints: new FileCheckpointStore(paths.dataRoot),
    decorateJournal: (journal) => journal,
    decorateProjections: (projections): ProjectionStore => ({
      read: projections.read.bind(projections),
      async write(projection) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
        await projections.write(projection);
      },
      list: projections.list.bind(projections),
      clear: projections.clear.bind(projections),
    }),
    decorateCheckpoints: (checkpoints) => checkpoints,
  });
  const second = composePersistence(paths, clock, {
    journal: new FileEventJournal(paths.dataRoot, clock),
    projections: new FileProjectionStore(paths.dataRoot),
    checkpoints: new FileCheckpointStore(paths.dataRoot),
    decorateJournal: (journal): EventJournal => ({
      append: journal.append.bind(journal),
      readStream: journal.readStream.bind(journal),
      async readAll(afterGlobalPosition, limit) {
        secondJournalReadStarted = true;
        return journal.readAll(afterGlobalPosition, limit);
      },
      latestGlobalPosition: journal.latestGlobalPosition.bind(journal),
      waitForEventsAfter: journal.waitForEventsAfter.bind(journal),
      changeSignal: journal.changeSignal,
      ...(journal.readLatest === undefined ? {} : { readLatest: journal.readLatest.bind(journal) }),
    }),
    decorateProjections: (projections) => projections,
    decorateCheckpoints: (checkpoints) => checkpoints,
  });
  const firstRuntime = createRuntimeProjectionSubscriptions(
    first.journal,
    first.projections,
    first.checkpoints,
    first.subscriptionRunSerialiser,
    [definition],
  );
  const secondRuntime = createRuntimeProjectionSubscriptions(
    second.journal,
    second.projections,
    second.checkpoints,
    second.subscriptionRunSerialiser,
    [definition],
  );

  try {
    await appendCountedEvent(first.journal, 'injected-file-event');
    const firstPass = firstRuntime.catchUp(definition);
    await firstWriteStarted.promise;
    const secondPass = secondRuntime.catchUp(definition);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondJournalReadStarted).toBe(false);
    releaseFirstWrite.resolve();
    await Promise.all([firstPass, secondPass]);
    expect(secondJournalReadStarted).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('lets a sibling subscription reach the journal head while another projection write blocks', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const checkpoints = new InMemoryCheckpointStore();
  const projections = new BlockingProjectionStore('blocked-projection', 'ready-projection');
  const runtime = createRuntimeProjectionSubscriptions(
    journal,
    projections,
    checkpoints,
    undefined,
    [countedProjection('blocked-projection'), countedProjection('ready-projection')],
  );
  await appendCountedEvent(journal, 'concurrent-event');
  const controller = new AbortController();
  const run = runtime.start(controller.signal);

  await projections.readyProjectionWritten.promise;
  await vi.waitFor(async () => {
    expect(await checkpoints.load('projection:ready-projection')).toBe(1);
  });
  expect(await checkpoints.load('projection:blocked-projection')).toBe(0);
  expect(runtime.health().map(({ consumer }) => consumer)).toEqual([
    'projection:blocked-projection',
    'projection:ready-projection',
  ]);

  controller.abort();
  projections.releaseBlockedProjection();
  await run.done;
});

function countedProjection(name: string): ProjectionDefinition<number> {
  return {
    name,
    select: () => ({ key: 'one' }),
    initial: () => 0,
    project: (previous) => previous + 1,
  };
}

async function appendCountedEvent(journal: EventJournal, eventId: string): Promise<void> {
  await appendCountedEvents(journal, eventId, 1);
}

async function appendCountedEvents(
  journal: EventJournal,
  eventIdPrefix: string,
  count: number,
): Promise<void> {
  const stream: EntityRef<'counter', 'projection-runtime'> = {
    kind: 'counter',
    id: 'projection-runtime',
  };
  await journal.append(
    stream,
    0,
    Array.from({ length: count }, (_, index) =>
      createEventDraft({
        eventId: `${eventIdPrefix}-${index}`,
        eventType: 'counted',
        occurredAt: '2026-08-29T00:00:00.000Z',
        correlationId: 'correlation',
        causationId: 'causation',
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream,
        payload: {},
      }),
    ),
  );
}

function recordingSerialiser(consumers: string[]): SubscriptionRunSerialiser {
  return async (consumer, _signal, operation) => {
    consumers.push(consumer);
    return operation();
  };
}

class BlockingProjectionStore extends InMemoryProjectionStore {
  private readonly blockedWrite = deferred<void>();
  readonly readyProjectionWritten = deferred<void>();

  constructor(
    private readonly blockedProjection: string,
    private readonly readyProjection: string,
  ) {
    super();
  }

  override async write<Value>(projection: {
    readonly namespace: string;
    readonly key: string;
    readonly lastGlobalPosition: number;
    readonly value: Value;
  }): Promise<void> {
    if (projection.namespace === this.blockedProjection) await this.blockedWrite.promise;
    await super.write(projection);
    if (projection.namespace === this.readyProjection) this.readyProjectionWritten.resolve();
  }

  releaseBlockedProjection(): void {
    this.blockedWrite.resolve();
  }
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
