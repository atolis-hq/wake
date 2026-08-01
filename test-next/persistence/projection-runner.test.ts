import { expect, it } from 'vitest';
import { createEventDraft, type EntityRef } from '../../src-next/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
  ProjectionRunner,
} from '../../src-next/persistence/index.js';
import { FakeClock } from '../e2e/support/world.js';

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
