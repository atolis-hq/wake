import {
  cachedJournalView,
  createEventData,
  WrongExpectedSequenceError,
  type StreamRef as EntityRef,
  type EventData,
} from '@atolis-hq/eventing';
import { FileEventJournal } from '@atolis-hq/eventing-filesystem';
import type * as FsPromises from 'node:fs/promises';
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const { readFileMock, renameMock, statMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  renameMock: vi.fn(),
  statMock: vi.fn(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  renameMock.mockImplementation(actual.rename);
  statMock.mockImplementation(actual.stat);
  return { ...actual, readFile: readFileMock, rename: renameMock, stat: statMock };
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

  renameMock.mockRejectedValueOnce(new Error('simulated atomic commit failure'));

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
  const view = cachedJournalView(reader, (events) => events.length);

  expect(await view.get()).toBe(0);
  await writer.appendToStream(stream, 0, [draft]);
  readerClock.advance(30_000);

  expect(await view.get()).toBe(1);
});

it('reuses validated segment fingerprints without parsing an unchanged warm journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-warm-cache-'));
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
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.appendToStream(stream, 0, [draft]);
  await journal.readAll(0);

  statMock.mockClear();
  await journal.readAll(0);

  expect(statMock.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toHaveLength(0);
  expect(
    statMock.mock.calls.filter(([path]) => String(path).endsWith('index-manifest.json')),
  ).toHaveLength(0);
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
    // Simulate the exact crash window: the authoritative append reached JSONL,
    // but the derived manifest was never updated.
    await appendFile(
      segmentPath,
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
  clock.advance(30_000);
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

it('coalesces concurrent reads on a cold cache into a single on-disk decode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-concurrent-'));
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
  await new FileEventJournal(root, new FakeClock()).appendToStream(stream, 0, [
    draft('event-1', 1),
    draft('event-2', 2),
  ]);

  // Force the scan fallback so this retains coverage for the coalescing
  // guard even when a valid persisted index would serve readAll directly.
  await writeFile(join(root, 'events', 'index-manifest.json'), '{not json', 'utf8');
  const reopened = new FileEventJournal(root, new FakeClock());
  readFileMock.mockClear();
  const [first, second, third] = await Promise.all([
    reopened.readAll(0),
    reopened.readAll(0),
    reopened.latestGlobalPosition(),
  ]);

  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  expect(third).toBe(2);
  const journalFileReads = readFileMock.mock.calls.filter(([path]) =>
    String(path).endsWith('.jsonl'),
  );
  expect(journalFileReads).toHaveLength(1);
});

it('shares one entry validation refresh across concurrent journal reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-shared-entry-refresh-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const entryReader = journalEntryReader(root);
  const reader = new FileEventJournal(root, clock, { entryReader });

  const [position, all, streamEvents] = await Promise.all([
    reader.latestGlobalPosition(),
    reader.readAll(0),
    reader.readStream(stream),
  ]);

  expect(position).toBe(1);
  expect(all.map((event) => event.event.eventId)).toEqual(['event-1']);
  expect(streamEvents.map((event) => event.event.eventId)).toEqual(['event-1']);
  expect(entryReader).toHaveBeenCalledOnce();
});

it('retries an entry validation refresh after its first attempt rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-entry-refresh-retry-'));
  const entryReader = vi
    .fn<() => Promise<readonly { file: string; size: number; mtimeMs: number }[]>>()
    .mockRejectedValueOnce(new Error('transient entry read failure'))
    .mockResolvedValue([]);
  const journal = new FileEventJournal(root, new FakeClock(), { entryReader });

  await expect(journal.latestGlobalPosition()).rejects.toThrow('transient entry read failure');
  await expect(journal.latestGlobalPosition()).resolves.toBe(0);

  expect(entryReader).toHaveBeenCalledTimes(2);
});

it('reuses a successful entry validation inside the hard refresh window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-entry-refresh-window-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const entryReader = journalEntryReader(root);
  const reader = new FileEventJournal(root, clock, { entryReader });

  await expect(reader.latestGlobalPosition()).resolves.toBe(1);
  clock.advance(29_999);
  await expect(reader.readAll(0)).resolves.toHaveLength(1);

  expect(entryReader).toHaveBeenCalledOnce();
});

it('invalidates entry validation when a watcher reports an external append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-watcher-entry-refresh-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const watcher = controlledWatcherFactory();
  const entryReader = journalEntryReader(root);
  const reader = new FileEventJournal(root, clock, {
    entryReader,
    watcherFactory: watcher.factory,
  });

  await expect(reader.latestGlobalPosition()).resolves.toBe(1);
  const wait = reader.waitForEventsAfter(1, new AbortController().signal, 10_000);
  await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
  await writer.appendToStream(stream, 1, [journalDraft('event-2')]);
  watcher.notify();
  await expect(wait).resolves.toBeUndefined();
  await expect(reader.readAll(0)).resolves.toHaveLength(2);

  expect(entryReader).toHaveBeenCalledTimes(2);
});

it('discovers an external append after the hard refresh when watcher setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-expired-entry-refresh-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.appendToStream(stream, 0, [journalDraft('event-1')]);
  const watcher = controlledWatcherFactory(new Error('watch unavailable'));
  const entryReader = journalEntryReader(root);
  const reader = new FileEventJournal(root, clock, {
    entryReader,
    watcherFactory: watcher.factory,
  });

  await expect(reader.latestGlobalPosition()).resolves.toBe(1);
  const cancelled = new AbortController();
  cancelled.abort();
  await reader.waitForEventsAfter(1, cancelled.signal, 1_000);
  await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
  await writer.appendToStream(stream, 1, [journalDraft('event-2')]);
  clock.advance(30_000);
  await expect(reader.readAll(0)).resolves.toHaveLength(2);

  expect(entryReader).toHaveBeenCalledTimes(2);
});

it('revalidates an in-flight local scan after an external append before assigning positions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stale-scan-'));
  const clock = new FakeClock();
  const primary: EntityRef<'work-item', 'primary'> = { kind: 'work-item', id: 'primary' };
  const external: EntityRef<'work-item', 'external'> = { kind: 'work-item', id: 'external' };
  const local: EntityRef<'work-item', 'local'> = { kind: 'work-item', id: 'local' };
  const draft = (stream: EntityRef, id: string) =>
    createEventData({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      payload: { objective: id },
    });
  const remoteWriter = new FileEventJournal(root, clock);
  await remoteWriter.appendToStream(primary, 0, [draft(primary, 'event-1')]);

  const segmentPath = join(root, 'events', '2026-07-30.jsonl');
  const journalLockPath = join(root, 'locks', 'event-journal.lock');
  const snapshotRead = deferred<void>();
  const releaseSnapshot = deferred<void>();
  const originalReadFile = readFileMock.getMockImplementation();
  if (originalReadFile === undefined)
    throw new Error('Expected the filesystem read mock implementation');
  let heldSnapshot = false;
  readFileMock.mockImplementation(async (...args) => {
    if (!heldSnapshot && String(args[0]) === segmentPath) {
      heldSnapshot = true;
      const contents = await originalReadFile(...args);
      snapshotRead.resolve();
      await releaseSnapshot.promise;
      return contents;
    }
    return originalReadFile(...args);
  });

  try {
    const localReader = new FileEventJournal(root, clock);
    const staleRead = localReader.latestGlobalPosition();
    await snapshotRead.promise;
    await remoteWriter.appendToStream(external, 0, [draft(external, 'event-2')]);
    const localAppend = localReader.appendToStream(local, 0, [draft(local, 'event-3')]);
    let localAppendSettled = false;
    void localAppend.then(
      () => {
        localAppendSettled = true;
      },
      () => {
        localAppendSettled = true;
      },
    );
    await vi.waitFor(async () => {
      if (localAppendSettled) return;
      expect(await readFile(journalLockPath, 'utf8')).toContain('compatibilityOwner');
    });
    releaseSnapshot.resolve();

    await expect(staleRead).resolves.toBe(1);
    await expect(localAppend).resolves.toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ eventId: 'event-3' }),
        globalPosition: 3,
      }),
    ]);
    await expect(new FileEventJournal(root, clock).readAll(0)).resolves.toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ eventId: 'event-1' }),
        globalPosition: 1,
      }),
      expect.objectContaining({
        event: expect.objectContaining({ eventId: 'event-2' }),
        globalPosition: 2,
      }),
      expect.objectContaining({
        event: expect.objectContaining({ eventId: 'event-3' }),
        globalPosition: 3,
      }),
    ]);
  } finally {
    releaseSnapshot.resolve();
    readFileMock.mockImplementation(originalReadFile);
  }
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
  await writeFile(join(root, 'events', 'index-manifest.json'), '{not json', 'utf8');

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
  const manifest = JSON.parse(
    await readFile(join(root, 'events', 'index-manifest.json'), 'utf8'),
  ) as { segments: Array<{ events: Array<{ offset: number }> }> };
  manifest.segments[0]!.events[1]!.offset = 0;
  await writeFile(join(root, 'events', 'index-manifest.json'), JSON.stringify(manifest), 'utf8');

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
  vi.useFakeTimers();
  try {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-fallback-wake-'));
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
    const watcher = controlledWatcherFactory(new Error('watch unavailable'));
    const clock = new FakeClock();
    const reader = new FileEventJournal(root, clock, { watcherFactory: watcher.factory });
    const writer = new FileEventJournal(root, new FakeClock());
    const wait = reader.waitForEventsAfter(0, new AbortController().signal, 1_000);

    await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
    await writer.appendToStream(stream, 0, [draft]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(wait).resolves.toBeUndefined();
    clock.advance(30_000);
    expect((await reader.readAll(0)).map((entry) => entry.event.eventId)).toEqual(['event-1']);
  } finally {
    vi.useRealTimers();
  }
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

function journalEntryReader(root: string) {
  return vi.fn(async () => {
    const directory = join(root, 'events');
    const files = (await readdir(directory))
      .filter((file) => /^\d{4}-\d{2}-\d{2}(?:~\d{20})?\.jsonl$/.test(file))
      .sort();
    return Promise.all(
      files.map(async (file) => {
        const info = await stat(join(directory, file));
        return { file, size: info.size, mtimeMs: info.mtimeMs };
      }),
    );
  });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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
