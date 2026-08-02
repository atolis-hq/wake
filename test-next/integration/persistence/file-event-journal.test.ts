import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createEventDraft, type EntityRef, type EventDraft } from '../../../src-next/kernel/index.js';
import { FileEventJournal } from '../../../src-next/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

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

it('round-trips every strict offset-ISO timestamp accepted by draft construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-timestamps-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const occurredAt = [
    '2026-07-30T12:00:00Z',
    '2026-07-30T12:00:00.123Z',
    '2026-07-30T13:00:00+01:00',
  ];
  const drafts = occurredAt.map((timestamp, index) =>
    createEventDraft({
      eventId: `event-${index + 1}`,
      eventType: 'work.item-created',
      occurredAt: timestamp,
      correlationId: 'corr',
      causationId: `event-${index + 1}`,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { objective: 'ship' },
    }),
  );

  await new FileEventJournal(root, new FakeClock()).append(stream, 0, drafts);

  await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).resolves.toEqual(
    expect.arrayContaining(
      occurredAt.map((timestamp) => expect.objectContaining({ occurredAt: timestamp })),
    ),
  );
});

it('validates a finalized envelope before filesystem serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-final-envelope-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const invalidDraft = {
    eventId: 'event-invalid',
    eventType: 'work.item-created',
    schemaVersion: 1,
    occurredAt: '2026-07-30',
    correlationId: 'corr',
    causationId: 'event-invalid',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: { objective: 'ship' },
  } as unknown as EventDraft;

  await expect(
    new FileEventJournal(root, new FakeClock()).append(stream, 0, [invalidDraft]),
  ).rejects.toThrow();
  await expect(readFile(join(root, 'events', '2026-07-30.jsonl'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('rejects malformed JSON with file and 1-based line context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-corrupt-json-'));
  await mkdir(join(root, 'events'));
  await writeFile(join(root, 'events', '2026-07-31.jsonl'), '{"eventId":\n', 'utf8');

  await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).rejects.toThrow(
    /2026-07-31\.jsonl:1/,
  );
});

it('rejects a malformed common envelope with file, line, and event context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-corrupt-envelope-'));
  await mkdir(join(root, 'events'));
  await writeFile(
    join(root, 'events', '2026-07-31.jsonl'),
    `${JSON.stringify({
      eventId: 'event-corrupt',
      eventType: 'work.item-created',
      schemaVersion: 1,
      occurredAt: '2026-07-31T12:00:00.000Z',
      recordedAt: '2026-07-31T12:00:01.000Z',
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      actor: { kind: 'robot', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream: { kind: 'work-item', id: 'work-1' },
      sequence: 1,
      globalPosition: 1,
      payload: { objective: 'Ship it' },
    })}\n`,
    'utf8',
  );

  await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).rejects.toThrow(
    /2026-07-31\.jsonl:1.*event-corrupt/i,
  );
});
