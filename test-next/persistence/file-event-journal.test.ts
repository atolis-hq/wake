import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEventDraft, type EntityRef } from '../../src-next/kernel/index.js';
import { FileEventJournal } from '../../src-next/persistence/index.js';
import { FakeClock } from '../e2e/support/world.js';
it('reopens the journal and continues stream sequence and global position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventDraft({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { objective: 'ship' },
    });
  await new FileEventJournal(root, new FakeClock()).append(stream, 0, [draft('event-1')]);
  const reopened = new FileEventJournal(root, new FakeClock());
  const appended = await reopened.append(stream, 1, [draft('event-2')]);
  expect(appended[0]).toMatchObject({ sequence: 2, globalPosition: 2 });
  expect((await reopened.readAll(0)).length).toBe(2);
});

it('returns an existing idempotent event while appending only new events in a mixed batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-mixed-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventDraft({
      eventId: id,
      eventType: 'work.changed',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { id },
    });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.append(stream, 0, [draft('event-1')]);
  const result = await journal.append(stream, 1, [draft('event-1'), draft('event-2')]);
  expect(result.map((event) => event.globalPosition)).toEqual([1, 2]);
  expect((await journal.readAll(0)).map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
});
