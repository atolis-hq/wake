import { createEventData, scanJournal } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it, vi } from 'vitest';
import { FakeClock } from './support/fake-clock.js';

const stream = { kind: 'test', id: 'scan' };
const draft = (index: number) =>
  createEventData({
    eventId: `event-${index}`,
    eventType: 'test.scanned',
    occurredAt: '2026-07-30T12:00:00Z',
    correlationId: 'corr',
    causationId: 'cause',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: {},
  });

it('bounds reads to the starting snapshot even when facts are appended during scanning', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: 150 }, (_, index) => draft(index)),
  );
  const reads = vi.spyOn(journal, 'readAll');
  let seen = 0;
  for await (const event of scanJournal(journal)) {
    seen++;
    if (event.globalPosition === 1) await journal.appendToStream(stream, 150, [draft(151)]);
  }
  expect(seen).toBe(150);
  expect(reads.mock.calls).toEqual([
    [0, 100],
    [100, 100],
  ]);
});

it('stops without further reads when aborted within a batch', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  await journal.appendToStream(
    stream,
    0,
    Array.from({ length: 200 }, (_, index) => draft(index)),
  );
  const reads = vi.spyOn(journal, 'readAll');
  const controller = new AbortController();
  const scan = async () => {
    for await (const event of scanJournal(journal, controller.signal)) {
      if (event.globalPosition === 1) controller.abort();
    }
  };
  await expect(scan()).rejects.toMatchObject({ name: 'AbortError' });
  expect(reads).toHaveBeenCalledTimes(1);
});
