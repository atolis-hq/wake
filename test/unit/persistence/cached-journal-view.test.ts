import { expect, it, vi } from 'vitest';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import { cachedJournalView } from '../../../src/persistence/application/cached-journal-view.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

const stream: EntityRef<'counter', 'one'> = { kind: 'counter', id: 'one' };

function draft(eventId: string) {
  return createEventDraft({
    eventId,
    eventType: 'counted',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cause',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: {},
  });
}

it('derives once and reuses the cached value across repeat calls when nothing new landed', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.append(stream, 0, [draft('event-1')]);
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  expect(await view.get()).toBe(1);
  expect(await view.get()).toBe(1);
  expect(await view.get()).toBe(1);

  expect(derive).toHaveBeenCalledTimes(1);
});

it('re-derives once new events land, then caches again at the new position', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.append(stream, 0, [draft('event-1')]);
  const derive = vi.fn((events: readonly unknown[]) => events.length);
  const view = cachedJournalView(journal, derive);

  expect(await view.get()).toBe(1);
  await journal.append(stream, 1, [draft('event-2')]);
  expect(await view.get()).toBe(2);
  expect(await view.get()).toBe(2);

  expect(derive).toHaveBeenCalledTimes(2);
});

it('does not call readAll at all when the cache is still valid', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.append(stream, 0, [draft('event-1')]);
  const readAllSpy = vi.spyOn(journal, 'readAll');
  const view = cachedJournalView(journal, (events) => events.length);

  await view.get();
  readAllSpy.mockClear();
  await view.get();
  await view.get();

  expect(readAllSpy).not.toHaveBeenCalled();
});
