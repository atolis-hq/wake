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
  type ProjectionDefinition,
} from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
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

it('keeps file-backed projection serialization when only one persistence port is injected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-projection-serialiser-'));
  const clock = new FakeClock();
  const paths = resolveWakePaths(root);
  const first = composePersistence(paths, clock, {
    journal: new InMemoryEventJournal(clock),
  });
  const second = composePersistence(paths, clock, {
    journal: new InMemoryEventJournal(clock),
  });
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  let secondStarted = false;

  try {
    const firstPass = first.subscriptionRunSerialiser(
      'projection:mixed-persistence',
      new AbortController().signal,
      async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    );
    await firstStarted.promise;
    const secondPass = second.subscriptionRunSerialiser(
      'projection:mixed-persistence',
      new AbortController().signal,
      async () => {
        secondStarted = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondStarted).toBe(false);
    releaseFirst.resolve();
    await Promise.all([firstPass, secondPass]);
    expect(secondStarted).toBe(true);
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

async function appendCountedEvent(journal: InMemoryEventJournal, eventId: string): Promise<void> {
  const stream: EntityRef<'counter', 'projection-runtime'> = {
    kind: 'counter',
    id: 'projection-runtime',
  };
  await journal.append(stream, 0, [
    createEventDraft({
      eventId,
      eventType: 'counted',
      occurredAt: '2026-08-29T00:00:00.000Z',
      correlationId: 'correlation',
      causationId: 'causation',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: {},
    }),
  ]);
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
