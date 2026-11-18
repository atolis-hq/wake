import { createEventData, type StreamRef as EntityRef } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

// Scaling fixtures publish thousands of files on real storage.
vi.setConfig({ testTimeout: 20_000 });

// A resident Wake home holds tens of thousands of one-event segments. These
// tests pin the cost of the hot journal operations to the size of the change,
// not the size of the history, without depending on wall-clock time.

afterEach(() => {
  vi.restoreAllMocks();
});

const draft = (eventId: string) =>
  createEventData({
    eventId,
    eventType: 'test.created',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: eventId,
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { value: eventId },
  });

const segmentName = (position: number): string =>
  position === 1 ? '2026-07-30.jsonl' : `2026-07-30~${String(position).padStart(20, '0')}.jsonl`;

/** Writes `count` one-event segments directly, as a long-lived journal would hold them. */
async function seedSegments(root: string, count: number, streams = 40): Promise<void> {
  await mkdir(join(root, 'events'), { recursive: true });
  const writes: Promise<void>[] = [];
  const sequences = new Map<string, number>();
  for (let position = 1; position <= count; position += 1) {
    const stream = `s${position % streams}`;
    const sequence = (sequences.get(stream) ?? 0) + 1;
    sequences.set(stream, sequence);
    const record = {
      eventId: `seed-${position}`,
      eventType: 'test.created',
      schemaVersion: 1,
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'corr',
      causationId: `seed-${position}`,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream: { kind: 'test', id: stream },
      payload: { value: position },
      recordedAt: '2026-07-30T12:00:00.000Z',
      sequence,
      globalPosition: position,
    };
    writes.push(
      writeFile(join(root, 'events', segmentName(position)), `${JSON.stringify(record)}\n`),
    );
  }
  await Promise.all(writes);
}

it('does not serialise history during steady-state appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-index-cost-'));
  await seedSegments(root, 3000);
  const journal = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'append' };
  await journal.appendToStream(stream, 0, [draft('first')]);
  const stringify = vi.spyOn(JSON, 'stringify');
  for (let index = 1; index <= 40; index += 1)
    await journal.appendToStream(stream, index, [draft(String(index))]);
  const largest = Math.max(
    ...stringify.mock.results.map((result) =>
      typeof result.value === 'string' ? result.value.length : 0,
    ),
  );
  expect(largest).toBeLessThan(2000);
});

it('uses the global and per-stream B-tree indexes for bounded lookups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-query-plan-'));
  await seedSegments(root, 3000);
  await new FileEventJournal(root, new FakeClock()).latestGlobalPosition();
  const db = new DatabaseSync(join(root, 'journal-index.sqlite'));
  try {
    const global = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM records WHERE position > 2900 ORDER BY position LIMIT 100',
      )
      .all();
    const stream = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM records WHERE stream = ? ORDER BY sequence')
      .all('["test","s1"]');
    expect(global.map((row) => row.detail).join(' ')).toContain(
      'SEARCH records USING INTEGER PRIMARY KEY',
    );
    expect(stream.map((row) => row.detail).join(' ')).toContain(
      'SEARCH records USING INDEX stream_sequence',
    );
  } finally {
    db.close();
  }
});

it('serves a cold reader without parsing unrelated segments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-tail-read-'));
  await seedSegments(root, 400, 8);
  const writer = new FileEventJournal(root, new FakeClock());
  const stream: EntityRef<'test', 'tail'> = { kind: 'test', id: 'tail' };
  await writer.appendToStream(stream, 0, [draft('in-base')]);
  await writer.appendToStream(stream, 1, [draft('in-tail')]);

  const reader = new FileEventJournal(root, new FakeClock());
  readFileMock.mockClear();
  expect((await reader.readStream(stream)).map((event) => event.event.eventId)).toEqual([
    'in-base',
    'in-tail',
  ]);
  // A full scan reads every segment whole; an index-driven read opens only the
  // records it needs, so no segment is read through readFile.
  expect(readFileMock.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toHaveLength(
    0,
  );
});

it('rebuilds after a dirty marker even when the directory stamp did not change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-dirty-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'one' };
  await journal.appendToStream(stream, 0, [draft('one')]);
  const db = new DatabaseSync(join(root, 'journal-index.sqlite'));
  db.exec('DELETE FROM records');
  db.close();
  await writeFile(join(root, 'journal-index.dirty'), 'pending');
  expect(await journal.latestGlobalPosition()).toBe(1);
  expect((await journal.readStream(stream))[0]?.event.eventId).toBe('one');
});

it('answers readAll and readLatest by position, with the same bounds as a scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-slice-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const stream: EntityRef<'test', 'slice'> = { kind: 'test', id: 'slice' };
  const total = 50;
  for (let index = 0; index < total; index += 1)
    await journal.appendToStream(stream, index, [draft(`event-${index}`)]);
  const all = await journal.readAll(0);
  expect(all).toHaveLength(total);

  for (const after of [-5, 0, 1, 2.5, 25, 49, 50, 51, Number.NaN])
    for (const limit of [0, 1, 7, Number.POSITIVE_INFINITY]) {
      const expected = all.filter((event) => event.globalPosition > after).slice(0, limit);
      expect(await journal.readAll(after, limit), `after=${after} limit=${limit}`).toEqual(
        expected,
      );
    }
  for (const before of [undefined, 1, 2, 26, 50, 51, 100])
    for (const limit of [1, 5, 100]) {
      const end = (before ?? total + 1) - 1;
      const expected = all.slice(0, end).slice(-limit).reverse();
      expect(await journal.readLatest(before, limit), `before=${before} limit=${limit}`).toEqual(
        expected,
      );
    }
});

it('never mutates a stream array already handed to a reader when the stream grows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cow-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const grown: EntityRef<'test', 'grown'> = { kind: 'test', id: 'grown' };
  const other: EntityRef<'test', 'other'> = { kind: 'test', id: 'other' };
  await journal.appendToStream(grown, 0, [draft('g-0')]);
  await journal.appendToStream(other, 0, [draft('o-0')]);
  const held = await journal.readStream(grown);
  const heldOther = await journal.readStream(other);

  await journal.appendToStream(grown, 1, [draft('g-1')]);

  expect(held.map((event) => event.event.eventId)).toEqual(['g-0']);
  expect((await journal.readStream(grown)).map((event) => event.event.eventId)).toEqual([
    'g-0',
    'g-1',
  ]);
  expect(await journal.readStream(other)).toEqual(heldOther);
});

it('reads a cold journal in listing order even when segment reads complete out of order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cold-order-'));
  await seedSegments(root, 500, 5);

  const events = await new FileEventJournal(root, new FakeClock()).readAll(0);

  expect(events.map((event) => event.globalPosition)).toEqual(
    Array.from({ length: 500 }, (_, index) => index + 1),
  );
});

it('keeps decoded envelopes bounded after head, replay, and stream reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-bounded-cache-'));
  await seedSegments(root, 3000);
  const journal = new FileEventJournal(root, new FakeClock());
  expect(await journal.latestGlobalPosition()).toBe(3000);
  const cache = (journal as unknown as { envelopeCache: ReadonlyMap<string, unknown> })
    .envelopeCache;
  expect(cache.size).toBe(1);
  expect(await journal.readAll(0)).toHaveLength(3000);
  expect(cache.size).toBe(256);
  expect(await journal.readStream({ kind: 'test', id: 's1' })).toHaveLength(75);
  expect(cache.size).toBe(256);
});
