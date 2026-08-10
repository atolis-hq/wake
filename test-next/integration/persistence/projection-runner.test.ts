import { expect, it, vi } from 'vitest';
import { createEventDraft, type EntityRef } from '../../../src-next/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  ProjectionRunner,
} from '../../../src-next/persistence/index.js';
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
