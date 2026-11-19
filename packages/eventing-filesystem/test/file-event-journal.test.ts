import {
  createEventData,
  foldedJournalView,
  WrongExpectedSequenceError,
  type StreamRef as EntityRef,
  type EventData,
} from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import type * as FsPromises from 'node:fs/promises';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const { readFileMock, readdirMock, renameMock, statMock, openMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  openMock: vi.fn(),
  readdirMock: vi.fn(),
  renameMock: vi.fn(),
  statMock: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  openMock.mockImplementation(actual.open);
  readdirMock.mockImplementation(actual.readdir);
  renameMock.mockImplementation(actual.rename);
  statMock.mockImplementation(actual.stat);
  return {
    ...actual,
    readFile: readFileMock,
    open: openMock,
    readdir: readdirMock,
    rename: renameMock,
    stat: statMock,
  };
});

it('loads the current flat JSONL record as a nested in-memory envelope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-flat-compatibility-'));
  await mkdir(join(root, 'events'));
  await copyFile(
    join(process.cwd(), 'test', 'fixtures', 'journal', 'current-flat-event.jsonl'),
    join(root, 'events', '2026-08-30.jsonl'),
  );

  await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).resolves.toEqual([
    {
      event: {
        eventId: 'event-1',
        eventType: 'test.created',
        schemaVersion: 1,
        occurredAt: '2026-08-30T12:00:00.000Z',
        correlationId: 'correlation-1',
        causationId: 'command-1',
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload: { value: 1 },
      },
      stream: { kind: 'test', id: '1' },
      recordedAt: '2026-08-30T12:00:00.001Z',
      sequence: 1,
      globalPosition: 1,
    },
  ]);
});

it('writes newly appended envelopes with the exact legacy flat JSONL shape and key order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-flat-write-'));
  const stream: EntityRef<'test', 'new'> = { kind: 'test', id: 'new' };
  const journal = new FileEventJournal(root, new FakeClock());

  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-new',
      eventType: 'test.created',
      occurredAt: '2026-07-30T11:59:59.000Z',
      correlationId: 'correlation-new',
      causationId: 'command-new',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { value: 2 },
    }),
  ]);

  const jsonl = await readFile(join(root, 'events', '2026-07-30.jsonl'), 'utf8');
  expect(jsonl).toBe(
    '{"eventId":"event-new","eventType":"test.created","schemaVersion":1,"occurredAt":"2026-07-30T11:59:59.000Z","correlationId":"correlation-new","causationId":"command-new","actor":{"kind":"system","id":"test"},"source":{"kind":"internal","id":"test"},"stream":{"kind":"test","id":"new"},"payload":{"value":2},"recordedAt":"2026-07-30T12:00:00.000Z","sequence":1,"globalPosition":1}\n',
  );
  expect(JSON.parse(jsonl)).not.toHaveProperty('event');
});

it('leaves the authoritative segment unchanged when an atomic batch commit fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-atomic-batch-'));
  const stream: EntityRef<'test', 'atomic'> = { kind: 'test', id: 'atomic' };
  const event = (eventId: string) =>
    createEventData({
      eventId,
      eventType: 'test.changed',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'correlation-atomic',
      causationId: eventId,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { eventId },
    });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [event('event-1')]);
  const segment = join(root, 'events', '2026-07-30.jsonl');
  const before = await readFile(segment, 'utf8');
  const revision = journal.changeSignal.revision();

  const rename = renameMock.getMockImplementation()!;
  renameMock
    .mockImplementationOnce((...args) => rename(...args))
    .mockRejectedValueOnce(new Error('simulated atomic commit failure'));

  await expect(
    journal.appendToStream(stream, 1, [event('event-2'), event('event-3')]),
  ).rejects.toThrow('simulated atomic commit failure');
  expect(await readFile(segment, 'utf8')).toBe(before);
  expect(await new FileEventJournal(root, new FakeClock()).readAll(0)).toHaveLength(1);
  expect(journal.changeSignal.revision()).toBe(revision);
});

it('reclaims only stale event-segment temp files while holding the append lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stale-segment-temp-'));
  const eventsDirectory = join(root, 'events');
  await mkdir(eventsDirectory, { recursive: true });
  const stale = join(
    eventsDirectory,
    '2026-07-30~00000000000000000002.jsonl.1234.1753876800000.123e4567-e89b-42d3-a456-426614174000.tmp',
  );
  const unrelated = join(eventsDirectory, 'operator-notes.tmp');
  await writeFile(stale, '{"partial":"uncommitted segment"}\n', 'utf8');
  await writeFile(unrelated, 'keep me', 'utf8');
  const stream: EntityRef<'test', 'cleanup'> = { kind: 'test', id: 'cleanup' };
  const journal = new FileEventJournal(root, new FakeClock());

  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-cleanup',
      eventType: 'test.changed',
      occurredAt: '2026-07-30T12:00:00.000Z',
      correlationId: 'correlation-cleanup',
      causationId: 'command-cleanup',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {},
    }),
  ]);

  await expect(readFile(stale, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(unrelated, 'utf8')).resolves.toBe('keep me');
  await expect(journal.readAll(0)).resolves.toHaveLength(1);
});

it('requires events, appends batches in sequence, and leaves the tail unchanged on rejected appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-append-to-stream-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const journal = new FileEventJournal(root, new FakeClock());

  await expect(journal.appendToStream(stream, 0, [])).rejects.toMatchObject({
    message: 'appendToStream requires at least one event',
  });
  expect(await journal.latestGlobalPosition()).toBe(0);

  const appended = await journal.appendToStream(stream, 0, [draft('event-1'), draft('event-2')]);

  expect(appended.map(({ sequence }) => sequence)).toEqual([1, 2]);
  expect(await journal.latestGlobalPosition()).toBe(2);

  await expect(journal.appendToStream(stream, 0, [draft('event-3')])).rejects.toBeInstanceOf(
    WrongExpectedSequenceError,
  );
  expect(await journal.latestGlobalPosition()).toBe(2);
});

it('reopens the journal and continues stream sequence and global position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  await new FileEventJournal(root, new FakeClock()).appendToStream(stream, 0, [draft('event-1')]);
  const reopened = new FileEventJournal(root, new FakeClock());
  const appended = await reopened.appendToStream(stream, 1, [draft('event-2')]);
  expect(appended[0]).toMatchObject({ sequence: 2, globalPosition: 2 });
  expect((await reopened.readAll(0)).length).toBe(2);
});

it('returns no latest events before a non-positive global position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-read-latest-before-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'event-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    }),
    createEventData({
      eventId: 'event-2',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'event-2',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    }),
  ]);

  await expect(journal.readLatest(0)).resolves.toEqual([]);
});

it('returns no latest events when the limit is non-positive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-read-latest-limit-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [
    createEventData({
      eventId: 'event-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'event-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    }),
  ]);

  await expect(journal.readLatest(undefined, 0)).resolves.toEqual([]);
});

it('appends every event in a complete batch even when producer event identities repeat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-mixed-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.changed',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { id },
    });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  const result = await journal.appendToStream(stream, 1, [draft('event-1'), draft('event-2')]);
  expect(result.map((event) => event.globalPosition)).toEqual([2, 3]);
  expect((await journal.readAll(0)).map((event) => event.event.eventId)).toEqual([
    'event-1',
    'event-1',
    'event-2',
  ]);
});

it('treats event identity as opaque producer data across streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cross-stream-replay-'));
  const streamA: EntityRef<'test', 'a'> = { kind: 'test', id: 'a' };
  const streamB: EntityRef<'test', 'b'> = { kind: 'test', id: 'b' };
  const draft = createEventData({
    eventId: 'event-1',
    eventType: 'test.changed',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'event-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { value: 1 },
  });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(streamA, 0, [draft]);
  await journal.appendToStream(streamB, 0, [draft]);

  expect(await journal.readStream(streamB)).toHaveLength(1);
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
    createEventData({
      eventId: `event-${index + 1}`,
      eventType: 'work.item-created',
      occurredAt: timestamp,
      correlationId: 'corr',
      causationId: `event-${index + 1}`,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    }),
  );

  await new FileEventJournal(root, new FakeClock()).appendToStream(stream, 0, drafts);

  await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).resolves.toEqual(
    expect.arrayContaining(
      occurredAt.map((timestamp) =>
        expect.objectContaining({ event: expect.objectContaining({ occurredAt: timestamp }) }),
      ),
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
    payload: { objective: 'ship' },
  } as unknown as EventData;

  await expect(
    new FileEventJournal(root, new FakeClock()).appendToStream(stream, 0, [invalidDraft]),
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

it('rejects a partial trailing JSONL line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-partial-tail-'));
  await mkdir(join(root, 'events'));
  await writeFile(join(root, 'events', '2026-07-31.jsonl'), '{"eventId":"partial"}', 'utf8');

  await expect(new FileEventJournal(root, new FakeClock()).readAll(0)).rejects.toThrow(
    'Incomplete trailing line in 2026-07-31.jsonl',
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

it('does not re-parse prior history from disk after appending new events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cache-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string, sequence: number) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: `event ${sequence}` },
    });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1', 1)]);
  await journal.appendToStream(stream, 1, [draft('event-2', 2)]);
  expect(await journal.readAll(0)).toHaveLength(2);

  readFileMock.mockClear();
  // A write patches the cache with the events already held in memory from
  // this same appendToStream(), so the following reads need no readFile calls
  // against the on-disk .jsonl history — not even for the newly appended
  // event — rather than re-parsing the whole journal. (appendToStream() still reads
  // its own lock file as part of acquiring the file lock, unrelated to
  // journal content.)
  await journal.appendToStream(stream, 2, [draft('event-3', 3)]);
  expect(await journal.readAll(0)).toHaveLength(3);
  expect(await journal.latestGlobalPosition()).toBe(3);
  const journalFileReads = readFileMock.mock.calls.filter(([path]) =>
    String(path).endsWith('.jsonl'),
  );
  expect(journalFileReads).toHaveLength(0);
});

it('refreshes a cached view when another file-journal instance appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cached-view-cross-instance-'));
  const stream: EntityRef<'work-item', 'cached-view'> = {
    kind: 'work-item',
    id: 'cached-view',
  };
  const draft = createEventData({
    eventId: 'cached-view-event',
    eventType: 'work.item-created',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cached-view-event',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { objective: 'ship' },
  });
  const writer = new FileEventJournal(root, new FakeClock());
  const readerClock = new FakeClock();
  const reader = new FileEventJournal(root, readerClock);
  const view = foldedJournalView(reader, {
    initial: 0,
    extend: (count, events) => count + events.length,
  });

  expect(await view.get()).toBe(0);
  await writer.appendToStream(stream, 0, [draft]);

  expect(await view.get()).toBe(1);
});

it('validates requested segment fingerprints on every indexed read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-fingerprint-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'one' };
  await journal.appendToStream(stream, 0, [journalDraft('one')]);
  const path = join(root, 'events', '2026-07-30.jsonl');
  const raw = await readFile(path, 'utf8');
  await writeFile(path, raw.replace('"eventId":"one"', '"eventId":"two"'));
  expect((await journal.readAll(0))[0]?.event.eventId).toBe('two');
});

it('recovers a warmed reader after a JSONL append crashes before manifest update', async () => {
  vi.useFakeTimers();
  try {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-manifest-crash-'));
    const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
    const draft = createEventData({
      eventId: 'event-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'event-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
    const writer = new FileEventJournal(root, new FakeClock());
    await writer.appendToStream(stream, 0, [draft]);

    const watcher = controlledWatcherFactory();
    const reader = new FileEventJournal(root, new FakeClock(), { watcherFactory: watcher.factory });
    expect(await reader.latestGlobalPosition()).toBe(1);

    const segmentPath = join(root, 'events', '2026-07-30.jsonl');
    const firstEvent = JSON.parse(await readFile(segmentPath, 'utf8')) as Record<string, unknown>;
    // Simulate the exact crash window: the authoritative append reached a new
    // segment, but the derived manifest was never updated.
    await writeFile(
      join(root, 'events', '2026-07-30~00000000000000000002.jsonl'),
      `${JSON.stringify({
        ...firstEvent,
        eventId: 'event-2',
        causationId: 'event-2',
        sequence: 2,
        globalPosition: 2,
      })}\n`,
      'utf8',
    );

    const wait = reader.waitForEventsAfter(1, new AbortController().signal, 1_000);
    await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
    watcher.notify();
    await expect(wait).resolves.toBeUndefined();

    expect(await reader.latestGlobalPosition()).toBe(2);
    expect((await reader.readAll(1)).map((event) => event.event.eventId)).toEqual(['event-2']);
  } finally {
    vi.useRealTimers();
  }
});

it('uses the refreshed warm-cache stream index for ordered, isolated stream reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stream-index-'));
  const workStream: EntityRef<'work-item', 'shared-id'> = {
    kind: 'work-item',
    id: 'shared-id',
  };
  const runStream: EntityRef<'run', 'shared-id'> = { kind: 'run', id: 'shared-id' };
  const missingStream: EntityRef<'work-item', 'missing'> = { kind: 'work-item', id: 'missing' };
  const draft = (stream: EntityRef, id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(workStream, 0, [draft(workStream, 'work-1')]);
  await writer.appendToStream(runStream, 0, [draft(runStream, 'run-1')]);
  await writer.appendToStream(workStream, 1, [draft(workStream, 'work-2')]);

  const reader = new FileEventJournal(root, clock);
  // A full read, unlike the cold manifest path, populates the in-memory
  // cache that the next stream read must refresh after an external append.
  await reader.latestGlobalPosition();
  expect((await reader.readStream(workStream)).map((event) => event.event.eventId)).toEqual([
    'work-1',
    'work-2',
  ]);
  expect((await reader.readStream(runStream)).map((event) => event.event.eventId)).toEqual([
    'run-1',
  ]);
  expect(await reader.readStream(missingStream)).toEqual([]);

  // A different journal instance changes the segment after this reader has
  // warmed its cache, so the hard refresh must rebuild both cache and index.
  await writer.appendToStream(runStream, 1, [draft(runStream, 'run-2')]);
  expect((await reader.readStream(runStream)).map((event) => event.event.eventId)).toEqual([
    'run-1',
    'run-2',
  ]);

  readFileMock.mockClear();
  expect((await reader.readStream(workStream)).map((event) => event.event.eventId)).toEqual([
    'work-1',
    'work-2',
  ]);
  expect(readFileMock.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toHaveLength(
    0,
  );
});

it('rebuilds a missing index once for concurrent local reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-concurrent-recovery-'));
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]);
  await rm(join(root, 'journal-index.sqlite'));
  const reader = new FileEventJournal(root, new FakeClock());
  readdirMock.mockClear();
  expect(
    await Promise.all([
      reader.latestGlobalPosition(),
      reader.latestGlobalPosition(),
      reader.latestGlobalPosition(),
    ]),
  ).toEqual([1, 1, 1]);
  expect(
    readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
  ).toHaveLength(2);
});

it('serves concurrent cold reads without listing the event directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-concurrent-index-'));
  const writer = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'one' };
  await writer.appendToStream(stream, 0, [journalDraft('one')]);
  const reader = new FileEventJournal(root, new FakeClock());
  readdirMock.mockClear();
  const [head, all, events] = await Promise.all([
    reader.latestGlobalPosition(),
    reader.readAll(0),
    reader.readStream(stream),
  ]);
  expect(head).toBe(1);
  expect(all).toHaveLength(1);
  expect(events).toHaveLength(1);
  expect(
    readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
  ).toHaveLength(0);
});

it('serialises many local reads without retaining decoded history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-many-reads-'));
  const journal = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'one' };
  await journal.appendToStream(stream, 0, [journalDraft('one')]);
  const reads = await Promise.all(Array.from({ length: 50 }, () => journal.readStream(stream)));
  expect(reads.every((events) => events.length === 1)).toBe(true);
  expect(reads[0]).not.toBe(reads[1]);
});

it('reflects completed foreign appends in every later read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-read-order-'));
  const writer = new FileEventJournal(root, new FakeClock());
  const reader = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'one' };
  await writer.appendToStream(stream, 0, [journalDraft('one')]);
  expect(await reader.latestGlobalPosition()).toBe(1);
  await writer.appendToStream(stream, 1, [journalDraft('two')]);
  expect(await reader.latestGlobalPosition()).toBe(2);
});

it('observes another instance’s append on the next read with no watcher and no validity window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-immediate-cross-host-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const watcher = controlledWatcherFactory(new Error('watch unavailable'));
  const reader = new FileEventJournal(root, clock, { watcherFactory: watcher.factory });
  expect(await reader.latestGlobalPosition()).toBe(1);

  await writer.appendToStream(stream, 1, [journalDraft('event-2')]);

  expect(await reader.latestGlobalPosition()).toBe(2);
  expect((await reader.readStream(stream)).map((event) => event.event.eventId)).toEqual([
    'event-1',
    'event-2',
  ]);
  await writer.appendToStream(stream, 2, [journalDraft('event-3')]);
  expect((await reader.readAll(2)).map((event) => event.event.eventId)).toEqual(['event-3']);
});

it('reads only the new segment when another instance appends to a warmed journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-incremental-foreign-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  for (let index = 0; index < 30; index += 1)
    await writer.appendToStream(stream, index, [journalDraft(`event-${index}`)]);
  const reader = new FileEventJournal(root, clock);
  expect(await reader.latestGlobalPosition()).toBe(30);

  await writer.appendToStream(stream, 30, [journalDraft('event-30')]);
  readFileMock.mockClear();

  expect(await reader.latestGlobalPosition()).toBe(31);
  expect((await reader.readStream(stream)).map((event) => event.event.eventId).at(-1)).toBe(
    'event-30',
  );
  expect(readFileMock.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toHaveLength(
    0,
  );
});

it('rejects a stale sequence after a foreign append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stale-sequence-'));
  const writer = new FileEventJournal(root, new FakeClock());
  const reader = new FileEventJournal(root, new FakeClock());
  const stream = { kind: 'test', id: 'one' };
  await reader.appendToStream(stream, 0, [journalDraft('one')]);
  await writer.appendToStream(stream, 1, [journalDraft('two')]);
  await expect(reader.appendToStream(stream, 1, [journalDraft('three')])).rejects.toBeInstanceOf(
    WrongExpectedSequenceError,
  );
  expect(await reader.latestGlobalPosition()).toBe(2);
});

it('recovers after a transient recovery listing failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-recovery-retry-'));
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]);
  await rm(join(root, 'journal-index.sqlite'));
  const original = readdirMock.getMockImplementation()!;
  readdirMock.mockImplementation(async (...args) => {
    if (String(args[0]) === join(root, 'events')) throw new Error('transient failure');
    return original(...args);
  });
  try {
    await expect(journal.latestGlobalPosition()).rejects.toThrow('transient failure');
  } finally {
    readdirMock.mockImplementation(original);
  }
  expect(await journal.latestGlobalPosition()).toBe(1);
});

it('uses the committed head regardless of directory timestamp age', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-unchanged-directory-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const reader = new FileEventJournal(root, clock);
  // The stamp only proves "unchanged" once it is older than timestamp granularity.
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  try {
    expect(await reader.latestGlobalPosition()).toBe(1);
    readdirMock.mockClear();
    expect(await reader.latestGlobalPosition()).toBe(1);
    expect(
      readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
    ).toHaveLength(0);

    await writer.appendToStream(stream, 1, [journalDraft('event-2')]);
    readdirMock.mockClear();
    expect(await reader.latestGlobalPosition()).toBe(2);
    expect(
      readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
    ).toHaveLength(0);
  } finally {
    now.mockRestore();
  }
});

it('sees committed appends inside the timestamp granularity window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-young-directory-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const reader = new FileEventJournal(root, clock);
  expect(await reader.latestGlobalPosition()).toBe(1);
  for (let index = 1; index < 6; index += 1) {
    await writer.appendToStream(stream, index, [journalDraft(`event-${index + 1}`)]);
    expect(await reader.latestGlobalPosition()).toBe(index + 1);
  }
});

it('treats the watcher only as a wake-up, never as a freshness requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-watcher-wakeup-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const watcher = controlledWatcherFactory();
  const reader = new FileEventJournal(root, clock, { watcherFactory: watcher.factory });

  await expect(reader.latestGlobalPosition()).resolves.toBe(1);
  const wait = reader.waitForEventsAfter(1, new AbortController().signal, 10_000);
  await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
  await writer.appendToStream(stream, 1, [journalDraft('event-2')]);
  watcher.notify();
  await expect(wait).resolves.toBeUndefined();
  await expect(reader.readAll(0)).resolves.toHaveLength(2);
});

it('assigns contiguous positions across concurrent writers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-writers-'));
  const writers = Array.from({ length: 8 }, () => new FileEventJournal(root, new FakeClock()));
  const appended = await Promise.all(
    writers.map((writer, index) =>
      writer.appendToStream({ kind: 'test', id: String(index) }, 0, [journalDraft(String(index))]),
    ),
  );
  expect(appended.map((events) => events[0]!.globalPosition).sort((a, b) => a - b)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(await writers[0]!.readAll(0)).toHaveLength(8);
});

it('readStream on a cold cache parses only the segment files that can hold that stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cold-stream-'));
  const streamA: EntityRef<'work-item', 'work-a'> = { kind: 'work-item', id: 'work-a' };
  const streamB: EntityRef<'work-item', 'work-b'> = { kind: 'work-item', id: 'work-b' };
  const draft = (stream: EntityRef, id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(streamA, 0, [draft(streamA, 'event-a1')]);
  clock.advance(24 * 60 * 60 * 1000);
  await writer.appendToStream(streamB, 0, [draft(streamB, 'event-b1')]);

  // A fresh instance has no in-memory cache, so this exercises the persisted
  // manifest built by the appends above rather than the in-process cache.
  readFileMock.mockClear();
  const reader = new FileEventJournal(root, clock);
  const events = await reader.readStream(streamA);
  expect(events.map((event) => event.event.eventId)).toEqual(['event-a1']);
  const wholeSegmentReads = readFileMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.endsWith('.jsonl'));
  expect(wholeSegmentReads).toEqual([]);
});

it('readAll(after) on a cold cache skips segments entirely at or before the given position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cold-tail-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [draft('event-1')]);
  clock.advance(24 * 60 * 60 * 1000);
  const appended = await writer.appendToStream(stream, 1, [draft('event-2')]);
  expect(appended[0]!.globalPosition).toBe(2);

  readFileMock.mockClear();
  const reader = new FileEventJournal(root, clock);
  const events = await reader.readAll(1);
  expect(events.map((event) => event.event.eventId)).toEqual(['event-2']);
  const wholeSegmentReads = readFileMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.endsWith('.jsonl'));
  expect(wholeSegmentReads).toEqual([]);
});

it('falls back to a full scan and still returns correct data when the persisted index is corrupt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stale-index-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.appendToStream(stream, 0, [draft('event-1'), draft('event-2')]);
  await writeFile(join(root, 'journal-index.sqlite'), '{not sqlite', 'utf8');

  const reader = new FileEventJournal(root, new FakeClock());
  expect((await reader.readAll(0)).map((event) => event.event.eventId)).toEqual([
    'event-1',
    'event-2',
  ]);
  expect((await reader.readStream(stream)).map((event) => event.event.eventId)).toEqual([
    'event-1',
    'event-2',
  ]);
});

it('falls back to a full scan when a valid-shaped persisted index points at the wrong record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-invalid-index-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.appendToStream(stream, 0, [draft('event-1'), draft('event-2')]);
  const index = new DatabaseSync(join(root, 'journal-index.sqlite'));
  index.exec('UPDATE records SET offset = 0 WHERE position = 2');
  index.close();

  const reader = new FileEventJournal(root, new FakeClock());
  expect((await reader.readAll(0)).map((event) => event.event.eventId)).toEqual([
    'event-1',
    'event-2',
  ]);
});

it('notifies changeSignal after a real write, and wakes multiple subscribers off one append', async () => {
  vi.useFakeTimers();
  try {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-change-signal-'));
    const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
    const draft = (id: string, sequence: number) =>
      createEventData({
        eventId: id,
        eventType: 'work.item-created',
        occurredAt: '2026-07-30T12:00:00Z',
        correlationId: 'corr',
        causationId: id,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        payload: { objective: `event ${sequence}` },
      });
    const journal = new FileEventJournal(root, new FakeClock());
    const initialRevision = journal.changeSignal.revision();

    await expect(journal.appendToStream(stream, 0, [])).rejects.toMatchObject({
      message: 'appendToStream requires at least one event',
    });
    expect(journal.changeSignal.revision()).toBe(initialRevision);

    await journal.appendToStream(stream, 0, [draft('event-1', 1), draft('event-2', 2)]);
    expect(journal.changeSignal.revision()).toBe(initialRevision + 1);

    await expect(journal.appendToStream(stream, 0, [draft('event-3', 3)])).rejects.toBeInstanceOf(
      WrongExpectedSequenceError,
    );
    expect(journal.changeSignal.revision()).toBe(initialRevision + 1);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstWait = journal.changeSignal.waitForChange(firstController.signal, 1_000);
    const secondWait = journal.changeSignal.waitForChange(secondController.signal, 1_000);

    await journal.appendToStream(stream, 2, [draft('event-3', 3)]);
    await Promise.all([firstWait, secondWait]);

    await journal.appendToStream(stream, 3, [draft('event-3', 3)]);
    expect(journal.changeSignal.revision()).toBe(initialRevision + 3);
  } finally {
    vi.useRealTimers();
  }
});

it('arms a watcher on a fresh root and wakes promptly after the first external append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-fresh-root-wake-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  const watcher = controlledWatcherFactory();
  const reader = new FileEventJournal(root, clock, { watcherFactory: watcher.factory });
  const controller = new AbortController();

  const wait = reader.waitForEventsAfter(0, controller.signal, 10_000);
  let watcherArmed = false;
  try {
    await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
    watcherArmed = true;
    await writer.appendToStream(stream, 0, [draft('event-1')]);
    watcher.notify();
    await wait;
  } finally {
    if (!watcherArmed) {
      controller.abort();
      await wait;
    }
  }

  expect(watcher.unref).toHaveBeenCalledOnce();
  expect((await reader.readAll(0)).map((entry) => entry.event.eventId)).toEqual(['event-1']);
});

it('discovers an external append by fallback when watcher setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-fallback-wake-'));
  const watcher = controlledWatcherFactory(new Error('watch unavailable'));
  const reader = new FileEventJournal(root, new FakeClock(), { watcherFactory: watcher.factory });
  const writer = new FileEventJournal(root, new FakeClock());
  const wait = reader.waitForEventsAfter(0, new AbortController().signal, 20);
  await writer.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]);
  await wait;
  expect(await reader.latestGlobalPosition()).toBe(1);
});

it('rearms the advisory watcher after a watcher failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-watcher-rearm-'));
  const watcher = controlledWatcherFactory();
  const journal = new FileEventJournal(root, new FakeClock(), { watcherFactory: watcher.factory });
  const controller = new AbortController();
  const wait = journal.waitForEventsAfter(0, controller.signal, 10_000);

  try {
    await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
    watcher.fail();
    await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledTimes(2));
  } finally {
    controller.abort();
    await wait;
  }

  expect(watcher.close).toHaveBeenCalledOnce();
});

function controlledWatcherFactory(failure?: Error) {
  let onChange: (() => void) | undefined;
  const errors: Array<() => void> = [];
  const unref = vi.fn();
  const close = vi.fn();
  return {
    factory: vi.fn(async (_directory: string, notify: () => void) => {
      if (failure !== undefined) throw failure;
      onChange = notify;
      return {
        unref,
        close,
        once(event: 'error', listener: () => void) {
          if (event === 'error') errors.push(listener);
        },
      };
    }),
    unref,
    close,
    notify() {
      onChange?.();
    },
    fail() {
      errors.shift()?.();
    },
  };
}

function journalDraft(eventId: string) {
  return createEventData({
    eventId,
    eventType: 'work.item-created',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: eventId,
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { objective: 'ship' },
  });
}

it('wakes every concurrent waiter from one external append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-many-waiters-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: 'ship' },
    });
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [draft('event-1')]);
  const reader = new FileEventJournal(root, clock);
  const checkpoint = await reader.latestGlobalPosition();
  const waits = Array.from({ length: 32 }, () =>
    reader.waitForEventsAfter(checkpoint, new AbortController().signal, 10_000),
  );

  await writer.appendToStream(stream, 1, [draft('event-2')]);

  await expect(Promise.all(waits)).resolves.toHaveLength(32);
});

it('stream reads observe cross-host appends immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cross-host-stream-'));
  const stream: EntityRef<'test', 'instructions'> = { kind: 'test', id: 'instructions' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  const reader = new FileEventJournal(root, clock);
  const draft = (eventId: string) =>
    createEventData({
      eventId,
      eventType: 'test.changed',
      occurredAt: clock.now().toISOString(),
      correlationId: 'cross-host-stream',
      causationId: eventId,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: {},
    });
  await writer.appendToStream(stream, 0, [draft('first')]);
  expect(await reader.readStream(stream)).toHaveLength(1);
  await writer.appendToStream(stream, 1, [draft('second')]);
  expect((await reader.readStream(stream)).map((event) => event.event.eventId)).toEqual([
    'first',
    'second',
  ]);
});

it('does not list the directory while a probe for the next segment finds nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-probe-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  // A recent clock, as in production: a cache far behind today is listed, not probed.
  const clock = { now: () => new Date() } as never;
  const journal = new FileEventJournal(root, clock);
  for (let index = 0; index < 5; index += 1)
    await journal.appendToStream(stream, index, [journalDraft(`event-${index}`)]);
  await journal.latestGlobalPosition();
  readdirMock.mockClear();

  // The directory changed moments ago, so its stamp alone could not be trusted.
  for (let call = 0; call < 50; call += 1) expect(await journal.latestGlobalPosition()).toBe(5);

  expect(
    readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
  ).toHaveLength(0);
});

it('still sees an append by another journal instance immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-probe-foreign-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const reader = new FileEventJournal(root, clock);
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-0')]);
  expect(await reader.latestGlobalPosition()).toBe(1);

  for (let index = 1; index < 6; index += 1) {
    await writer.appendToStream(stream, index, [journalDraft(`event-${index}`)]);
    expect(await reader.latestGlobalPosition()).toBe(index + 1);
    expect((await reader.readStream(stream)).length).toBe(index + 1);
  }
});

it('keeps idle reads independent of history after time passes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-probe-interval-'));
    const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
    const journal = new FileEventJournal(root, new FakeClock());
    await journal.appendToStream(stream, 0, [journalDraft('event-0')]);
    await journal.latestGlobalPosition();
    readdirMock.mockClear();

    vi.setSystemTime(Date.now() + 6_000);
    await journal.latestGlobalPosition();

    expect(
      readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
    ).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

it('sees a first-of-day append by an instance whose clock is on an earlier day than today', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-probe-skew-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clockAt = (iso: string) => ({ now: () => new Date(iso) });
  const writerA = new FileEventJournal(root, clockAt('2026-01-01T12:00:00Z') as never);
  const reader = new FileEventJournal(root, clockAt('2026-01-01T12:00:00Z') as never);
  // The writer's clock names its segment for a day that is neither the reader's
  // last segment day, today, nor tomorrow.
  const skewed = new FileEventJournal(root, clockAt('2026-01-05T23:59:59Z') as never);
  await writerA.appendToStream(stream, 0, [journalDraft('event-0')]);
  expect(await reader.latestGlobalPosition()).toBe(1);

  await skewed.appendToStream(stream, 1, [journalDraft('event-1')]);

  expect(await reader.latestGlobalPosition()).toBe(2);
  expect((await reader.readStream(stream)).length).toBe(2);
});

it('does not list event files during cold or warm steady-state appends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-no-append-listing-'));
  const stream = { kind: 'test', id: 'one' };
  await new FileEventJournal(root, new FakeClock()).appendToStream(stream, 0, [
    journalDraft('one'),
  ]);
  readdirMock.mockClear();
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.appendToStream(stream, 1, [journalDraft('two')]);
  await writer.appendToStream(stream, 2, [journalDraft('three')]);
  expect(
    readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
  ).toHaveLength(0);
});

it('returns a committed append and heals on the next read after an index write fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-index-write-failure-'));
  const stream = { kind: 'test', id: 'one' };
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [journalDraft('one')]);
  const original = DatabaseSync.prototype.prepare;
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (sql.startsWith('INSERT INTO records')) throw new Error('simulated index write failure');
    return original.call(this, sql);
  });
  try {
    expect(await journal.appendToStream(stream, 1, [journalDraft('two')])).toHaveLength(1);
    expect(await readFile(join(root, 'journal-index.dirty'), 'utf8')).toBe('pending');
  } finally {
    prepare.mockRestore();
  }
  expect((await journal.readStream(stream)).map((event) => event.event.eventId)).toEqual([
    'one',
    'two',
  ]);
  await expect(readFile(join(root, 'journal-index.dirty'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('does not retain the results of an unbounded read in its serialisation queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-no-result-cache-'));
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]);
  const all = await journal.readAll(0);
  expect(all).toHaveLength(1);
  expect(await (journal as unknown as { queue: Promise<unknown> }).queue).toBeUndefined();
});

it('keeps explicit diagnostic reads non-mutating with missing and corrupt indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-read-only-'));
  const reader = new FileEventJournal(root, new FakeClock(), { readOnly: true });
  expect(await reader.latestGlobalPosition()).toBe(0);
  expect(await reader.readAll(0)).toEqual([]);
  expect(await readdir(root)).toEqual([]);
  await expect(
    reader.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]),
  ).rejects.toThrow('Read-only');
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]);
  const index = join(root, 'journal-index.sqlite');
  await rm(index);
  const before = await readdir(root);
  expect(await reader.readAll(0)).toHaveLength(1);
  expect(await readdir(root)).toEqual(before);
  await writeFile(index, 'corrupt index');
  expect(await reader.readStream({ kind: 'test', id: 'one' })).toHaveLength(1);
  expect(await readFile(index, 'utf8')).toBe('corrupt index');
});

it('releases its SQLite snapshot before segment I/O so a writer can commit concurrently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-reader-writer-'));
  const stream = { kind: 'test', id: 'one' };
  const writer = new FileEventJournal(root, new FakeClock());
  const reader = new FileEventJournal(root, new FakeClock());
  await writer.appendToStream(stream, 0, [journalDraft('one')]);
  const original = openMock.getMockImplementation()!;
  let release!: () => void;
  let observed!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let paused = false;
  openMock.mockImplementation(async (...args) => {
    if (!paused && String(args[0]).endsWith('.jsonl')) {
      paused = true;
      observed();
      await held;
    }
    return original(...args);
  });
  const reading = reader.readAll(0);
  try {
    await started;
    readdirMock.mockClear();
    await writer.appendToStream(stream, 1, [journalDraft('two')]);
    await expect(readFile(join(root, 'journal-index.dirty'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      readdirMock.mock.calls.filter(([path]) => String(path) === join(root, 'events')),
    ).toHaveLength(0);
  } finally {
    release();
    openMock.mockImplementation(original);
  }
  expect(await reading).toHaveLength(1);
  expect(await reader.readStream(stream)).toHaveLength(2);
}, 15_000);

it.each(['replay', 'stream', 'append'] as const)(
  'recovers an omitted interior record before %s',
  async (operation) => {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-omission-'));
    const journal = new FileEventJournal(root, new FakeClock());
    const lost = { kind: 'test', id: 'lost' };
    await journal.appendToStream({ kind: 'test', id: 'first' }, 0, [journalDraft('first')]);
    await journal.appendToStream(lost, 0, [journalDraft('interior')]);
    await journal.appendToStream({ kind: 'test', id: 'last' }, 0, [journalDraft('last')]);
    const index = new DatabaseSync(join(root, 'journal-index.sqlite'));
    index.exec('DELETE FROM records WHERE position = 2');
    index.close();
    const reader = operation === 'stream' ? journal : new FileEventJournal(root, new FakeClock());
    if (operation === 'stream')
      expect((await reader.readStream(lost)).map((event) => event.sequence)).toEqual([1]);
    if (operation === 'replay')
      expect((await reader.readAll(0)).map((event) => event.globalPosition)).toEqual([1, 2, 3]);
    if (operation === 'append') {
      await expect(
        reader.appendToStream(lost, 0, [journalDraft('invalid')]),
      ).rejects.toBeInstanceOf(WrongExpectedSequenceError);
      expect((await reader.appendToStream(lost, 1, [journalDraft('valid')]))[0]?.sequence).toBe(2);
    }
    expect((await reader.readStream(lost))[0]?.event.eventId).toBe('interior');
  },
);

it('rebuilds an unsupported partially initialized SQLite schema from JSONL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-partial-schema-'));
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream({ kind: 'test', id: 'one' }, 0, [journalDraft('one')]);
  const path = join(root, 'journal-index.sqlite');
  await rm(path);
  const partial = new DatabaseSync(path);
  partial.exec('CREATE TABLE head (stamp TEXT)');
  partial.close();
  expect((await journal.readAll(0)).map((event) => event.event.eventId)).toEqual(['one']);
});
