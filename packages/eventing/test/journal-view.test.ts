import { createEventData, foldedJournalView, type StreamRef } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
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

it('reads only the events after the position it already holds, however long the history', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: 200 }, (_, index) => draft(`event-${index}`)),
  );
  const view = foldedJournalView(journal, {
    initial: 0,
    extend: (value, events) => value + events.length,
  });
  expect(await view.get()).toBe(200);
  const readAll = vi.spyOn(journal, 'readAll');

  await journal.appendToStream(stream, 200, [draft('event-200')]);
  expect(await view.get()).toBe(201);

  expect(readAll.mock.calls).toEqual([[200]]);
});

it('refreshes after another journal instance appends without a local notification', async () => {
  let eventCount = 0;
  const journal = {
    readAll: async (after: number) =>
      Array.from({ length: eventCount - after }, (_, index) => ({
        globalPosition: after + index + 1,
      })),
    latestGlobalPosition: async () => eventCount,
  } as never;
  const view = foldedJournalView(journal, {
    initial: 0,
    extend: (value, events) => value + events.length,
  });

  expect(await view.get()).toBe(0);
  eventCount = 1;

  expect(await view.get()).toBe(1);
});
