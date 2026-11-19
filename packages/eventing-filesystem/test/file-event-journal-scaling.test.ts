import { createEventData, type StreamRef as EntityRef } from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import { statSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  return { ...actual, readFile: readFileMock };
});

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

it('does not re-serialise the whole segment index on every append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-manifest-cost-'));
  const segments = 3_000;
  await seedSegments(root, segments);
  const journal = new FileEventJournal(root, new FakeClock());
  const stream: EntityRef<'test', 'append'> = { kind: 'test', id: 'append' };
  // The first append of a process writes the base index once.
  await journal.appendToStream(stream, 0, [draft('first')]);
  const baseBytes = statSync(join(root, 'events', 'index-manifest.json')).size;
  expect(baseBytes).toBeGreaterThan(500_000);

  const stringify = vi.spyOn(JSON, 'stringify');
  const appends = 40;
  for (let index = 1; index <= appends; index += 1)
    await journal.appendToStream(stream, index, [draft(`event-${index}`)]);

  const serialisedChars = stringify.mock.results.reduce(
    (total, result) => total + (typeof result.value === 'string' ? result.value.length : 0),
    0,
  );
  // Indexing the whole history per append would serialise `baseBytes` characters
  // each time; the tail holds only the segments added since the base was written.
  expect(serialisedChars / appends).toBeLessThan(baseBytes / 4);
  expect(statSync(join(root, 'events', 'index-manifest.json')).size).toBe(baseBytes);
});

// Durable writes on sandbox storage can exceed the default five-second timeout.
it('rewrites the base index only once per tail window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-manifest-compaction-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const stream: EntityRef<'test', 'append'> = { kind: 'test', id: 'append' };
  const bases = new Set<string>();
  const appends = 600;
  for (let index = 0; index < appends; index += 1) {
    await journal.appendToStream(stream, index, [draft(`event-${index}`)]);
    const info = statSync(join(root, 'events', 'index-manifest.json'));
    bases.add(`${info.ino}:${info.mtimeMs}`);
  }

  // Once at the start, then every 256 appended segments: not once per append.
  expect(bases.size).toBeLessThanOrEqual(Math.ceil(appends / 256) + 1);
  const tail = JSON.parse(
    await readFile(join(root, 'events', 'index-manifest.tail.json'), 'utf8'),
  ) as { segments: unknown[] };
  expect(tail.segments.length).toBeLessThanOrEqual(256);
}, 120_000);

it('serves a cold reader from the base index plus its tail without parsing unrelated segments', async () => {
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

it('falls back to the segments when the tail does not extend the base', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stale-tail-'));
  const writer = new FileEventJournal(root, new FakeClock());
  const stream: EntityRef<'test', 'stale'> = { kind: 'test', id: 'stale' };
  for (let index = 0; index < 5; index += 1)
    await writer.appendToStream(stream, index, [draft(`event-${index}`)]);
  const tailPath = join(root, 'events', 'index-manifest.tail.json');
  const tail = JSON.parse(await readFile(tailPath, 'utf8')) as { baseSegments: number };
  await writeFile(tailPath, JSON.stringify({ ...tail, baseSegments: tail.baseSegments + 7 }));

  const reader = new FileEventJournal(root, new FakeClock());
  expect((await reader.readAll(0)).map((event) => event.event.eventId)).toEqual([
    'event-0',
    'event-1',
    'event-2',
    'event-3',
    'event-4',
  ]);
  // The next append heals the derived index for the following cold reader.
  await reader.appendToStream(stream, 5, [draft('event-5')]);
  expect(await new FileEventJournal(root, new FakeClock()).readAll(4)).toHaveLength(2);
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
  // Streams the append did not touch keep sharing their existing array.
  expect(await journal.readStream(other)).toBe(heldOther);
});

it('reads a cold journal in listing order even when segment reads complete out of order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cold-order-'));
  await seedSegments(root, 500, 5);

  const events = await new FileEventJournal(root, new FakeClock()).readAll(0);

  expect(events.map((event) => event.globalPosition)).toEqual(
    Array.from({ length: 500 }, (_, index) => index + 1),
  );
});
