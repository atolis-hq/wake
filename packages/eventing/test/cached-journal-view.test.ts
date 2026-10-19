import {
  cachedJournalView,
  createEventData,
  foldedJournalView,
  JOURNAL_CHANGE_FALLBACK_MS,
  type StreamRef,
} from '@atolis-hq/eventing';
import { InMemoryEventJournal, InProcessJournalChangeSignal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const stream: StreamRef<'counter', 'one'> = { kind: 'counter', id: 'one' };

function draft(eventId: string) {
  return createEventData({
    eventId,
    eventType: 'counted',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cause',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: {},
  });
}

it('derives once and reuses the cached value across repeat calls when nothing new landed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  expect(await view.get()).toBe(1);
  expect(await view.get()).toBe(1);
  expect(await view.get()).toBe(1);

  expect(derive).toHaveBeenCalledTimes(1);
});

it('re-derives once new events land, then caches again at the new position', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  expect(await view.get()).toBe(1);
  await journal.appendToStream(stream, 1, [draft('event-2')]);
  expect(await view.get()).toBe(2);
  expect(await view.get()).toBe(2);

  expect(derive).toHaveBeenCalledTimes(2);
});

it('does not call readAll at all when the cache is still valid', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  const readAllSpy = vi.spyOn(journal, 'readAll');
  const view = cachedJournalView(journal, (events) => events.length);

  await view.get();
  readAllSpy.mockClear();
  await view.get();
  await view.get();

  expect(readAllSpy).not.toHaveBeenCalled();
});

it('checks the durable journal position when the cached view is unchanged', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const latestPositionSpy = vi.spyOn(journal, 'latestGlobalPosition');
  const view = cachedJournalView(journal, (events) => events.length);

  await view.get();
  await view.get();

  expect(latestPositionSpy).toHaveBeenCalledTimes(2);
});

it('refreshes after an in-process append notification', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  expect(await view.get()).toBe(0);
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  expect(await view.get()).toBe(1);
  expect(derive).toHaveBeenCalledTimes(2);
});

it('refreshes when another journal instance appends without a local notification', async () => {
  let eventCount = 0;
  const journal = {
    readAll: async () =>
      Array.from({ length: eventCount }, (_, index) => ({ globalPosition: index + 1 })),
    latestGlobalPosition: async () => eventCount,
    changeSignal: new InProcessJournalChangeSignal(),
  } as never;
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  expect(await view.get()).toBe(0);
  eventCount = 1;

  expect(await view.get()).toBe(1);
  expect(derive).toHaveBeenCalledTimes(2);
});

it('refreshes on the fallback when an in-process notification is missed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  let now = 0;
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(
    {
      readAll: journal.readAll.bind(journal),
      latestGlobalPosition: journal.latestGlobalPosition.bind(journal),
      // Models a notification the consumer misses, including writes by a
      // separate process that cannot reach this process-local signal.
      changeSignal: { revision: () => 0 },
    } as never,
    derive,
    () => now,
  );

  expect(await view.get()).toBe(0);
  await journal.appendToStream(stream, 0, [draft('missed-notification')]);
  now = JOURNAL_CHANGE_FALLBACK_MS;
  expect(await view.get()).toBe(1);
  expect(derive).toHaveBeenCalledTimes(2);
});

it('starts the fallback window after a slow derivation completes', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  let now = 0;
  const derive = vi.fn((events: readonly unknown[]) => {
    now = JOURNAL_CHANGE_FALLBACK_MS;
    return events.length;
  });
  const view = cachedJournalView(journal, derive, () => now);

  await view.get();
  await view.get();

  expect(derive).toHaveBeenCalledTimes(1);
});

it('keys the cache by the position it actually read, never by one sampled before the read', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  // The journal moves between sampling the position and reading: the cache must
  // hold the older value under the position it was derived from, not the sample.
  const realLatest = journal.latestGlobalPosition.bind(journal);
  let lie = true;
  vi.spyOn(journal, 'latestGlobalPosition').mockImplementation(async () => {
    const position = await realLatest();
    return lie ? position + 1 : position;
  });
  const realReadAll = journal.readAll.bind(journal);
  vi.spyOn(journal, 'readAll').mockImplementation(async (after, limit) => {
    const events = await realReadAll(after, limit);
    return events.slice(0, 1);
  });
  const view = cachedJournalView(journal, (events) => events.length);

  expect(await view.get()).toBe(1);
  lie = false;
  await journal.appendToStream(stream, 1, [draft('event-2')]);
  vi.mocked(journal.readAll).mockImplementation(realReadAll);
  expect(await view.get()).toBe(2);
});

it('shares one derivation between callers that find the journal at the same position', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  const derive = vi.fn(async (events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  const values = await Promise.all(Array.from({ length: 50 }, () => view.get()));

  expect(values.every((value) => value === 1)).toBe(true);
  expect(derive).toHaveBeenCalledTimes(1);
});

it('folds each event exactly once and in order, however many callers ask at once', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1'), draft('event-2')]);
  const extend = vi.fn(
    (value: readonly string[], events: readonly { event: { eventId: string } }[]) => [
      ...value,
      ...events.map((event) => event.event.eventId),
    ],
  );
  const view = foldedJournalView<readonly string[]>(journal, { initial: [], extend });

  const first = await Promise.all(Array.from({ length: 20 }, () => view.get()));
  expect(first.every((value) => value.join() === 'event-1,event-2')).toBe(true);

  await journal.appendToStream(stream, 2, [draft('event-3')]);
  const [a, b] = await Promise.all([view.get(), view.get()]);

  expect(a.join()).toBe('event-1,event-2,event-3');
  expect(b).toBe(a);
  expect(extend.mock.calls.map(([, events]) => events.length)).toEqual([2, 1]);
});

it('returns the held value without reading when nothing new landed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(stream, 0, [draft('event-1')]);
  const view = foldedJournalView(journal, {
    initial: 0,
    extend: (value, events) => value + events.length,
  });
  expect(await view.get()).toBe(1);
  const readAll = vi.spyOn(journal, 'readAll');

  expect(await view.get()).toBe(1);

  expect(readAll).not.toHaveBeenCalled();
});
