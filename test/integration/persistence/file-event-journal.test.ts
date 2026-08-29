import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  cachedJournalView,
  createEventDraft,
  type EntityRef,
  type EventDraft,
} from '../../../src/kernel/index.js';
import { FileEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

const { readFileMock, statMock } = vi.hoisted(() => ({ readFileMock: vi.fn(), statMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  readFileMock.mockImplementation(actual.readFile);
  statMock.mockImplementation(actual.stat);
  return { ...actual, readFile: readFileMock, stat: statMock };
});

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

it('does not re-parse prior history from disk after appending new events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cache-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = (id: string, sequence: number) =>
    createEventDraft({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { objective: `event ${sequence}` },
    });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.append(stream, 0, [draft('event-1', 1)]);
  await journal.append(stream, 1, [draft('event-2', 2)]);
  expect(await journal.readAll(0)).toHaveLength(2);

  readFileMock.mockClear();
  // A write patches the cache with the events already held in memory from
  // this same append(), so the following reads need no readFile calls
  // against the on-disk .jsonl history — not even for the newly appended
  // event — rather than re-parsing the whole journal. (append() still reads
  // its own lock file as part of acquiring the file lock, unrelated to
  // journal content.)
  await journal.append(stream, 2, [draft('event-3', 3)]);
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
  const draft = createEventDraft({
    eventId: 'cached-view-event',
    eventType: 'work.item-created',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cached-view-event',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: { objective: 'ship' },
  });
  const writer = new FileEventJournal(root, new FakeClock());
  const reader = new FileEventJournal(root, new FakeClock());
  const view = cachedJournalView(reader, (events) => events.length);

  expect(await view.get()).toBe(0);
  await writer.append(stream, 0, [draft]);

  expect(await view.get()).toBe(1);
});

it('checks only the manifest for an unchanged warm journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-warm-cache-'));
  const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
  const draft = createEventDraft({
    eventId: 'event-1',
    eventType: 'work.item-created',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'event-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: { objective: 'ship' },
  });
  const journal = new FileEventJournal(root, new FakeClock());
  await journal.append(stream, 0, [draft]);
  await journal.readAll(0);

  statMock.mockClear();
  await journal.readAll(0);

  expect(statMock.mock.calls.filter(([path]) => String(path).endsWith('.jsonl'))).toHaveLength(0);
  expect(
    statMock.mock.calls.filter(([path]) => String(path).endsWith('index-manifest.json')),
  ).toHaveLength(1);
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
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.append(workStream, 0, [draft(workStream, 'work-1')]);
  await writer.append(runStream, 0, [draft(runStream, 'run-1')]);
  await writer.append(workStream, 1, [draft(workStream, 'work-2')]);

  const reader = new FileEventJournal(root, clock);
  // A full read, unlike the cold manifest path, populates the in-memory
  // cache that the next stream read must refresh after an external append.
  await reader.latestGlobalPosition();
  expect((await reader.readStream(workStream)).map((event) => event.eventId)).toEqual([
    'work-1',
    'work-2',
  ]);
  expect((await reader.readStream(runStream)).map((event) => event.eventId)).toEqual(['run-1']);
  expect(await reader.readStream(missingStream)).toEqual([]);

  // A different journal instance changes the segment after this reader has
  // warmed its cache, so the next read must rebuild both cache and index.
  await writer.append(runStream, 1, [draft(runStream, 'run-2')]);
  expect((await reader.readStream(runStream)).map((event) => event.eventId)).toEqual([
    'run-1',
    'run-2',
  ]);

  readFileMock.mockClear();
  expect((await reader.readStream(workStream)).map((event) => event.eventId)).toEqual([
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
    createEventDraft({
      eventId: id,
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: id,
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { objective: `event ${sequence}` },
    });
  await new FileEventJournal(root, new FakeClock()).append(stream, 0, [
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

it('readStream on a cold cache parses only the segment files that can hold that stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cold-stream-'));
  const streamA: EntityRef<'work-item', 'work-a'> = { kind: 'work-item', id: 'work-a' };
  const streamB: EntityRef<'work-item', 'work-b'> = { kind: 'work-item', id: 'work-b' };
  const draft = (stream: EntityRef, id: string) =>
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
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.append(streamA, 0, [draft(streamA, 'event-a1')]);
  clock.advance(24 * 60 * 60 * 1000);
  await writer.append(streamB, 0, [draft(streamB, 'event-b1')]);

  // A fresh instance has no in-memory cache, so this exercises the persisted
  // manifest built by the appends above rather than the in-process cache.
  readFileMock.mockClear();
  const reader = new FileEventJournal(root, clock);
  const events = await reader.readStream(streamA);
  expect(events.map((event) => event.eventId)).toEqual(['event-a1']);
  const wholeSegmentReads = readFileMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.endsWith('.jsonl'));
  expect(wholeSegmentReads).toEqual([]);
});

it('readAll(after) on a cold cache skips segments entirely at or before the given position', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-cold-tail-'));
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
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.append(stream, 0, [draft('event-1')]);
  clock.advance(24 * 60 * 60 * 1000);
  const appended = await writer.append(stream, 1, [draft('event-2')]);
  expect(appended[0]!.globalPosition).toBe(2);

  readFileMock.mockClear();
  const reader = new FileEventJournal(root, clock);
  const events = await reader.readAll(1);
  expect(events.map((event) => event.eventId)).toEqual(['event-2']);
  const wholeSegmentReads = readFileMock.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.endsWith('.jsonl'));
  expect(wholeSegmentReads).toEqual([]);
});

it('falls back to a full scan and still returns correct data when the persisted index is corrupt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-stale-index-'));
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
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.append(stream, 0, [draft('event-1'), draft('event-2')]);
  await writeFile(join(root, 'events', 'index-manifest.json'), '{not json', 'utf8');

  const reader = new FileEventJournal(root, new FakeClock());
  expect((await reader.readAll(0)).map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
  expect((await reader.readStream(stream)).map((event) => event.eventId)).toEqual([
    'event-1',
    'event-2',
  ]);
});

it('falls back to a full scan when a valid-shaped persisted index points at the wrong record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-invalid-index-'));
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
  const writer = new FileEventJournal(root, new FakeClock());
  await writer.append(stream, 0, [draft('event-1'), draft('event-2')]);
  const manifest = JSON.parse(
    await readFile(join(root, 'events', 'index-manifest.json'), 'utf8'),
  ) as { segments: Array<{ events: Array<{ offset: number }> }> };
  manifest.segments[0]!.events[1]!.offset = 0;
  await writeFile(join(root, 'events', 'index-manifest.json'), JSON.stringify(manifest), 'utf8');

  const reader = new FileEventJournal(root, new FakeClock());
  expect((await reader.readAll(0)).map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
});

it('notifies changeSignal after a real write, and wakes multiple subscribers off one append', async () => {
  vi.useFakeTimers();
  try {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-change-signal-'));
    const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
    const draft = (id: string, sequence: number) =>
      createEventDraft({
        eventId: id,
        eventType: 'work.item-created',
        occurredAt: '2026-07-30T12:00:00Z',
        correlationId: 'corr',
        causationId: id,
        actor: { kind: 'system', id: 'test' },
        source: { kind: 'internal', id: 'test' },
        stream,
        payload: { objective: `event ${sequence}` },
      });
    const journal = new FileEventJournal(root, new FakeClock());
    await journal.append(stream, 0, [draft('event-1', 1)]);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstWait = journal.changeSignal.waitForChange(firstController.signal, 1_000);
    const secondWait = journal.changeSignal.waitForChange(secondController.signal, 1_000);

    await journal.append(stream, 1, [draft('event-2', 2)]);
    await Promise.all([firstWait, secondWait]);

    // Idempotently resubmitting the same already-recorded draft is a no-op
    // write and must not fire changeSignal.
    let wokeOnReplay = false;
    const replayWait = journal.changeSignal
      .waitForChange(firstController.signal, 1_000)
      .then(() => {
        wokeOnReplay = true;
      });
    await journal.append(stream, 1, [draft('event-2', 2)]);
    await vi.advanceTimersByTimeAsync(1);
    expect(wokeOnReplay).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await replayWait;
    expect(wokeOnReplay).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it('arms a watcher on a fresh root and wakes promptly after the first external append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-fresh-root-wake-'));
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
    await writer.append(stream, 0, [draft('event-1')]);
    watcher.notify();
    await wait;
  } finally {
    if (!watcherArmed) {
      controller.abort();
      await wait;
    }
  }

  expect(watcher.unref).toHaveBeenCalledOnce();
  expect((await reader.readAll(0)).map((entry) => entry.eventId)).toEqual(['event-1']);
});

it('discovers an external append by fallback when watcher setup fails', async () => {
  vi.useFakeTimers();
  try {
    const root = await mkdtemp(join(tmpdir(), 'wake-journal-fallback-wake-'));
    const stream: EntityRef<'work-item', 'work-1'> = { kind: 'work-item', id: 'work-1' };
    const draft = createEventDraft({
      eventId: 'event-1',
      eventType: 'work.item-created',
      occurredAt: '2026-07-30T12:00:00Z',
      correlationId: 'corr',
      causationId: 'event-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload: { objective: 'ship' },
    });
    const watcher = controlledWatcherFactory(new Error('watch unavailable'));
    const reader = new FileEventJournal(root, new FakeClock(), { watcherFactory: watcher.factory });
    const writer = new FileEventJournal(root, new FakeClock());
    const wait = reader.waitForEventsAfter(0, new AbortController().signal, 1_000);

    await vi.waitFor(() => expect(watcher.factory).toHaveBeenCalledOnce());
    await writer.append(stream, 0, [draft]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(wait).resolves.toBeUndefined();
    expect((await reader.readAll(0)).map((entry) => entry.eventId)).toEqual(['event-1']);
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

it('wakes every concurrent waiter from one external append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-journal-many-waiters-'));
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
  const clock = new FakeClock();
  const writer = new FileEventJournal(root, clock);
  await writer.append(stream, 0, [draft('event-1')]);
  const reader = new FileEventJournal(root, clock);
  const checkpoint = await reader.latestGlobalPosition();
  const waits = Array.from({ length: 32 }, () =>
    reader.waitForEventsAfter(checkpoint, new AbortController().signal, 10_000),
  );

  await writer.append(stream, 1, [draft('event-2')]);

  await expect(Promise.all(waits)).resolves.toHaveLength(32);
});
