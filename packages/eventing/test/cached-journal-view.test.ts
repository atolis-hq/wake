import {
  cachedJournalView,
  createEventData,
  InProcessJournalChangeSignal,
  JOURNAL_CHANGE_FALLBACK_MS,
  type StreamRef,
} from '@atolis-hq/eventing';
import { expect, it, vi } from 'vitest';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../../test/e2e/support/world.js';

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
