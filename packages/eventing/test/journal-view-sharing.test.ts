import {
  JOURNAL_VIEW_PAGE_SIZE,
  createEventData,
  foldedJournalView,
  warmJournalViews,
  type StreamRef,
} from '@atolis-hq/eventing';
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

const count = {
  name: 'count',
  initial: 0,
  extend: (value: number, events: readonly unknown[]) => value + events.length,
};

async function journalOf(total: number) {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: total }, (_, index) => draft(`event-${index}`)),
  );
  return journal;
}

it('lets N views catching up concurrently share one replay', async () => {
  const total = JOURNAL_VIEW_PAGE_SIZE * 3 + 5;
  const journal = await journalOf(total);
  const readAll = vi.spyOn(journal, 'readAll');
  const views = Array.from({ length: 5 }, () => foldedJournalView(journal, count));

  const values = await Promise.all(views.map((view) => view.get()));

  expect(values).toEqual(Array(5).fill(total));
  expect(readAll).toHaveBeenCalledTimes(4);
});

it('shares pages with a view that starts while the leader is mid-replay', async () => {
  const total = JOURNAL_VIEW_PAGE_SIZE * 4;
  const journal = await journalOf(total);
  const readAll = vi.spyOn(journal, 'readAll');
  const leader = foldedJournalView(journal, count).get();
  await Promise.resolve();
  const follower = foldedJournalView(journal, count).get();

  expect(await Promise.all([leader, follower])).toEqual([total, total]);
  // 4 full pages read once for both views, plus at most one empty tail read each (unshared: 10).
  expect(readAll.mock.calls.length).toBeLessThanOrEqual(6);
});

it('drops retained pages once no catch-up is running, so a late view sees new appends', async () => {
  const journal = await journalOf(JOURNAL_VIEW_PAGE_SIZE);
  await foldedJournalView(journal, count).get();
  await journal.appendToStream(stream, JOURNAL_VIEW_PAGE_SIZE, [draft('late')]);

  expect(await foldedJournalView(journal, count).get()).toBe(JOURNAL_VIEW_PAGE_SIZE + 1);
});

it('does not serve a short page that predates the caller', async () => {
  const journal = await journalOf(3);
  const first = foldedJournalView(journal, count);
  const second = foldedJournalView(journal, count);
  const a = first.get();
  await journal.appendToStream(stream, 3, [draft('during')]);
  const b = second.get();

  expect(await a).toBeGreaterThanOrEqual(3);
  expect(await b).toBe(4);
});

it('starts over when the journal head moves backwards', async () => {
  let events = 10;
  const journal = {
    readAll: async (after: number, limit = 100) =>
      Array.from({ length: Math.min(limit, events - after) }, (_, index) => ({
        globalPosition: after + index + 1,
      })),
    latestGlobalPosition: async () => events,
  } as never;
  const view = foldedJournalView<number>(journal, count);
  expect(await view.get()).toBe(10);

  events = 4;

  expect(await view.get()).toBe(4);
});

it('warms views that would otherwise start at staggered moments with one replay', async () => {
  const total = JOURNAL_VIEW_PAGE_SIZE * 40;
  const journal = await journalOf(total);
  const readAll = vi.spyOn(journal, 'readAll');
  const views = Array.from({ length: 4 }, () => foldedJournalView(journal, count));

  await warmJournalViews(journal);
  // Past the window a late starter would have had to replay on its own.
  const late = await Promise.all(views.map((view) => view.get()));

  expect(late).toEqual(Array(4).fill(total));
  expect(readAll).toHaveBeenCalledTimes(41);
});
