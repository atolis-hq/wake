import { expect, it, vi } from 'vitest';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  ProjectionRunner,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('replays a committed event exactly once and rebuilds derived state only', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'one'> = { kind: 'counter', id: 'one' };
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'event-1',
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
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const runner = new ProjectionRunner(journal, projections, checkpoints);
  const definition = {
    name: 'counts',
    select: () => ({ key: 'one' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
  expect(await runner.runOnce(definition)).toBe(1);
  await checkpoints.reset('projection:counts');
  expect(await runner.runOnce(definition)).toBe(1);
  expect((await projections.read<number>('counts', 'one'))?.value).toBe(1);
  expect(await runner.rebuild(definition)).toBe(1);
  expect((await journal.readAll(0)).length).toBe(1);
});

it('skips per-projection checkpoint reads on a repeat call when no new events landed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const loadSpy = vi.spyOn(checkpoints, 'load');
  const definition = {
    name: 'idle-counts',
    select: () => ({ key: 'one' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
  const runner = new ProjectionRunner(journal, projections, checkpoints, [definition]);

  expect(await runner.runRegisteredOnce()).toBe(0);
  expect(loadSpy).toHaveBeenCalledTimes(1);

  loadSpy.mockClear();
  expect(await runner.runRegisteredOnce()).toBe(0);
  expect(loadSpy).not.toHaveBeenCalled();
});

it('does not read the journal again after catching up until it changes', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const runner = new ProjectionRunner(
    journal,
    new InMemoryProjectionStore(),
    new InMemoryCheckpointStore(),
    [projectionDefinition('unchanged-journal')],
  );
  const readAllSpy = vi.spyOn(journal, 'readAll');

  await runner.runRegisteredOnce();
  readAllSpy.mockClear();
  await runner.runRegisteredOnce();

  expect(readAllSpy).not.toHaveBeenCalled();
});

it('reads the journal again after an append notification', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'notification'> = { kind: 'counter', id: 'notification' };
  const runner = new ProjectionRunner(
    journal,
    new InMemoryProjectionStore(),
    new InMemoryCheckpointStore(),
    [projectionDefinition('notification-counts')],
  );

  await runner.runRegisteredOnce();
  const readAllSpy = vi.spyOn(journal, 'readAll');
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'notification-event',
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
  expect(await runner.runRegisteredOnce()).toBe(1);

  expect(readAllSpy).toHaveBeenCalledTimes(1);
});

it('keeps draining a backlog larger than the batch limit across repeat calls', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'two'> = { kind: 'counter', id: 'two' };
  for (let index = 0; index < 150; index++) {
    await journal.append(stream, index, [
      createEventDraft({
        eventId: `event-${index}`,
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
  const projections = new InMemoryProjectionStore();
  const checkpoints = new InMemoryCheckpointStore();
  const definition = {
    name: 'backlog-counts',
    select: () => ({ key: 'two' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
  const runner = new ProjectionRunner(journal, projections, checkpoints, [definition]);

  expect(await runner.runRegisteredOnce(100)).toBe(100);
  expect(await runner.runRegisteredOnce(100)).toBe(50);
  expect((await projections.read<number>('backlog-counts', 'two'))?.value).toBe(150);
});

it('does not reset a projection checkpoint while another projection pass is saving it', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'rebuild'> = { kind: 'counter', id: 'rebuild' };
  for (let index = 0; index < 3; index++) {
    await journal.append(stream, index, [
      createEventDraft({
        eventId: `rebuild-event-${index}`,
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
  const projections = new InMemoryProjectionStore();
  const checkpoints = new BlockingCheckpointStore();
  await checkpoints.save('projection:rebuild-counts', 2);
  const definition = {
    name: 'rebuild-counts',
    select: () => ({ key: 'rebuild' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
  const runner = new ProjectionRunner(
    journal,
    projections,
    checkpoints,
    [definition],
    serializeProjectionRuns,
  );

  const activePass = runner.runRegisteredOnce();
  await checkpoints.firstSaveStarted;
  const rebuild = runner.rebuild(definition);

  let secondSaveStarted = false;
  void checkpoints.secondSaveStarted.then(() => {
    secondSaveStarted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(secondSaveStarted).toBe(false);
  checkpoints.releaseFirstSave();
  await activePass;
  await checkpoints.secondSaveStarted;
  checkpoints.releaseSecondSave();
  await rebuild;

  expect(await checkpoints.load('projection:rebuild-counts')).toBe(3);
  expect((await projections.read<number>('rebuild-counts', 'rebuild'))?.value).toBe(3);
});

it('waits for sibling registered projections to settle before releasing a failed pass', async () => {
  projectionRunTail = Promise.resolve();
  projectionPassesStarted = 0;
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'counter', 'settlement'> = { kind: 'counter', id: 'settlement' };
  await journal.append(stream, 0, [
    createEventDraft({
      eventId: 'settlement-event',
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
  const projections = new FailingSiblingProjectionStore();
  const runner = new ProjectionRunner(
    journal,
    projections,
    new InMemoryCheckpointStore(),
    [projectionDefinition('slow-settlement'), projectionDefinition('failing-settlement')],
    serializeProjectionRuns,
  );

  const first = runner.runRegisteredOnce().catch((error: unknown) => error);
  await projections.firstSlowWriteStarted;
  await projections.failingProjectionObserved;
  const second = runner.runRegisteredOnce().catch((error: unknown) => error);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(projectionPassesStarted).toBe(1);

  projections.releaseFirstSlowWrite();
  await expect(first).resolves.toBeInstanceOf(Error);
  await expect(second).resolves.toBeInstanceOf(Error);
});

class BlockingCheckpointStore extends InMemoryCheckpointStore {
  private firstSaveRelease: (() => void) | undefined;
  private secondSaveRelease: (() => void) | undefined;
  private saveCount = 0;

  readonly firstSaveStarted = new Promise<void>((resolve) => {
    this.firstSaveRelease = resolve;
  });

  readonly secondSaveStarted = new Promise<void>((resolve) => {
    this.secondSaveRelease = resolve;
  });

  override async save(consumer: string, position: number): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === 2) {
      this.firstSaveRelease?.();
      await new Promise<void>((resolve) => {
        this.firstSaveRelease = resolve;
      });
    }
    if (this.saveCount === 3) {
      this.secondSaveRelease?.();
      await new Promise<void>((resolve) => {
        this.secondSaveRelease = resolve;
      });
    }
    await super.save(consumer, position);
  }

  releaseFirstSave() {
    this.firstSaveRelease?.();
  }

  releaseSecondSave() {
    this.secondSaveRelease?.();
  }
}

class FailingSiblingProjectionStore extends InMemoryProjectionStore {
  private firstSlowWriteRelease: (() => void) | undefined;
  private isFirstSlowWrite = true;
  private slowWriteStartedResolve: (() => void) | undefined;
  private failingObservedResolve: (() => void) | undefined;

  private readonly firstSlowWrite = new Promise<void>((resolve) => {
    this.firstSlowWriteRelease = resolve;
  });

  readonly firstSlowWriteStarted = new Promise<void>((resolve) => {
    this.slowWriteStartedResolve = resolve;
  });

  readonly failingProjectionObserved = new Promise<void>((resolve) => {
    this.failingObservedResolve = resolve;
  });

  override async read<Value>(namespace: string, key: string) {
    if (namespace === 'failing-settlement') {
      await this.firstSlowWriteStarted;
      this.failingObservedResolve?.();
      throw new Error('injected sibling projection failure');
    }
    return super.read<Value>(namespace, key);
  }

  override async write<Value>(projection: {
    readonly namespace: string;
    readonly key: string;
    readonly lastGlobalPosition: number;
    readonly value: Value;
  }): Promise<void> {
    if (projection.namespace === 'slow-settlement' && this.isFirstSlowWrite) {
      this.isFirstSlowWrite = false;
      this.slowWriteStartedResolve?.();
      await this.firstSlowWrite;
    }
    await super.write(projection);
  }

  releaseFirstSlowWrite() {
    this.firstSlowWriteRelease?.();
  }
}

function projectionDefinition(name: string) {
  return {
    name,
    select: () => ({ key: 'one' }),
    initial: () => 0,
    project: (previous: number) => previous + 1,
  };
}

let projectionRunTail: Promise<void> = Promise.resolve();
let projectionPassesStarted = 0;

function serializeProjectionRuns<Value>(operation: () => Promise<Value>): Promise<Value> {
  const result = projectionRunTail.then(async () => {
    projectionPassesStarted += 1;
    return operation();
  });
  projectionRunTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
