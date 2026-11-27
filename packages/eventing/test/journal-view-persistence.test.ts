import {
  createEventData,
  foldedJournalView,
  registerViewSnapshotStore,
  type StreamRef,
  type ViewPersistence,
  type ViewSnapshotRecord,
} from '@atolis-hq/eventing';
import { InMemoryEventJournal, InMemoryViewSnapshotStore } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const stream: StreamRef<'counter', 'one'> = { kind: 'counter', id: 'one' };

const draft = (eventId: string) =>
  createEventData({
    eventId,
    eventType: 'counted',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cause',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: {},
  });

async function journalOf(total: number) {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: total }, (_, index) => draft(`event-${index}`)),
  );
  return journal;
}

function persisted(
  store: InMemoryViewSnapshotStore,
  overrides: Partial<ViewPersistence<number>> = {},
) {
  return {
    name: 'count',
    initial: 0,
    extend: (value: number, events: readonly unknown[]) => value + events.length,
    persist: {
      schemaVersion: 1,
      codec: {
        encode: (value: number) => value,
        decode: (raw: unknown) => {
          if (typeof raw !== 'number') throw new Error('bad snapshot');
          return raw;
        },
      },
      store,
      minEvents: 10,
      minIntervalMs: 0,
      ...overrides,
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('restarts a persisted view with no historical rows read', async () => {
  const journal = await journalOf(5_000);
  const store = new InMemoryViewSnapshotStore();
  expect(await foldedJournalView(journal, persisted(store)).get()).toBe(5_000);
  await settle();
  await journal.appendToStream(stream, 5_000, [draft('after')]);
  const readAll = vi.spyOn(journal, 'readAll');

  expect(await foldedJournalView(journal, persisted(store)).get()).toBe(5_001);

  const rows = (await Promise.all(readAll.mock.results.map((r) => r.value))).flat().length;
  expect(rows).toBeLessThanOrEqual(2);
});

it('resolves the store registered for the journal when the view names none', async () => {
  const journal = await journalOf(50);
  const store = new InMemoryViewSnapshotStore();
  registerViewSnapshotStore(journal, store);
  const { persist, ...fold } = persisted(store);
  const { store: _unused, ...withoutStore } = persist;

  await foldedJournalView(journal, { ...fold, persist: withoutStore }).get();
  await settle();

  expect((await store.load('count'))?.position).toBe(50);
});

it.each([
  ['an older schema version', (r: ViewSnapshotRecord) => ({ ...r, schemaVersion: 0 })],
  ['a corrupt value', (r: ViewSnapshotRecord) => ({ ...r, value: 'garbage' })],
  ['a position ahead of the journal head', (r: ViewSnapshotRecord) => ({ ...r, position: 9_999 })],
  [
    'an anchor that is not this journal',
    (r: ViewSnapshotRecord) => ({ ...r, anchorEventId: 'other' }),
  ],
])('falls back to a full replay with identical results for %s', async (_name, damage) => {
  const journal = await journalOf(200);
  const store = new InMemoryViewSnapshotStore();
  await foldedJournalView(journal, persisted(store)).get();
  await settle();
  store.replace('count', damage((await store.load('count'))!));
  const readAll = vi.spyOn(journal, 'readAll');

  const value = await foldedJournalView(journal, persisted(store)).get();

  expect(value).toBe(200);
  expect(readAll.mock.calls.some(([after]) => after === 0)).toBe(true);
});

it('discards a snapshot after a journal restore moves the head back', async () => {
  const journal = await journalOf(100);
  const store = new InMemoryViewSnapshotStore();
  await foldedJournalView(journal, persisted(store)).get();
  await settle();
  const restored = await journalOf(40);
  registerViewSnapshotStore(restored, store);

  expect(await foldedJournalView(restored, persisted(store)).get()).toBe(40);
});

it('does not persist a small advance or more often than the interval', async () => {
  const journal = await journalOf(5);
  const store = new InMemoryViewSnapshotStore();
  await foldedJournalView(journal, persisted(store)).get();
  await settle();
  expect(await store.load('count')).toBeNull();

  let now = 0;
  const throttled = persisted(store, { minEvents: 1, minIntervalMs: 1_000, now: () => now });
  const view = foldedJournalView(journal, throttled);
  await view.get();
  await settle();
  const first = (await store.load('count'))?.position;
  await journal.appendToStream(stream, 5, [draft('x')]);
  await view.get();
  await settle();
  expect((await store.load('count'))?.position).toBe(first);
  now = 2_000;
  await journal.appendToStream(stream, 6, [draft('y')]);
  await view.get();
  await settle();
  expect((await store.load('count'))?.position).toBe(7);
});

it('advances an unchanged value without rewriting it', async () => {
  const journal = await journalOf(50);
  const store = new InMemoryViewSnapshotStore();
  const save = vi.spyOn(store, 'save');
  const unchanged = {
    ...persisted(store, { minEvents: 1 }),
    extend: (value: number, events: readonly unknown[]) =>
      events.length === 0 ? value : value + (events.length > 0 ? 0 : 1),
  };
  const view = foldedJournalView(journal, unchanged);
  await view.get();
  await settle();
  const value = (await store.load('count'))!.value;
  expect(save).toHaveBeenCalledTimes(1);

  await journal.appendToStream(stream, 50, [draft('later')]);
  await view.get();
  await settle();

  const stored = (await store.load('count'))!;
  expect(save).toHaveBeenCalledTimes(1);
  expect(stored.value).toBe(value);
  expect(stored.position).toBe(51);
  const readAll = vi.spyOn(journal, 'readAll');
  expect(await foldedJournalView(journal, unchanged).get()).toBe(value);
  expect(readAll.mock.calls.every(([after]) => after >= 50)).toBe(true);
});
