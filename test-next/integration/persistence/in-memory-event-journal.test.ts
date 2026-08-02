import { describe, expect, it } from 'vitest';
import {
  createEventDraft,
  WrongExpectedSequenceError,
  type Clock,
  type EntityRef,
  type EventDraft,
} from '../../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../../src-next/persistence/index.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-07-30T12:30:00.000Z');
  }
}

const stream: EntityRef<'test', 'journal'> = { kind: 'test', id: 'journal' };

function event(
  eventId: string,
  eventType = 'test.happened',
  payload: unknown = { value: eventId },
): EventDraft {
  return createEventDraft({
    eventId,
    eventType,
    occurredAt: '2026-07-30T12:00:00.000Z',
    correlationId: 'corr-1',
    causationId: 'cmd-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload,
  });
}

describe('in-memory event journal', () => {
  it('assigns stream sequence and global position atomically', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());

    const appended = await journal.append(stream, 0, [event('evt-1'), event('evt-2')]);

    expect(appended.map(({ sequence, globalPosition }) => ({ sequence, globalPosition }))).toEqual([
      { sequence: 1, globalPosition: 1 },
      { sequence: 2, globalPosition: 2 },
    ]);
    expect(appended.map(({ recordedAt }) => recordedAt)).toEqual([
      '2026-07-30T12:30:00.000Z',
      '2026-07-30T12:30:00.000Z',
    ]);
  });

  it('rejects an append whose expected sequence is stale', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());
    await journal.append(stream, 0, [event('evt-1')]);

    await expect(journal.append(stream, 0, [event('evt-2')])).rejects.toBeInstanceOf(
      WrongExpectedSequenceError,
    );
    expect(await journal.readStream(stream)).toHaveLength(1);
  });

  it('reads a logical stream in sequence order', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());
    const other: EntityRef<'test', 'other'> = { kind: 'test', id: 'other' };
    await journal.append(stream, 0, [event('evt-1')]);
    await journal.append(other, 0, [
      createEventDraft({ ...event('evt-2'), stream: other, eventId: 'evt-2' }),
    ]);
    await journal.append(stream, 1, [event('evt-3')]);

    expect((await journal.readStream(stream)).map(({ eventId }) => eventId)).toEqual([
      'evt-1',
      'evt-3',
    ]);
  });

  it('reads all events after an exclusive global position', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());
    await journal.append(stream, 0, [event('evt-1'), event('evt-2'), event('evt-3')]);

    expect((await journal.readAll(1, 1)).map(({ eventId }) => eventId)).toEqual(['evt-2']);
    expect((await journal.readAll(1)).map(({ eventId }) => eventId)).toEqual(['evt-2', 'evt-3']);
  });

  it('returns the prior append for a repeated event id instead of duplicating it', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());
    const draft = event('evt-1');
    const first = await journal.append(stream, 0, [draft]);

    const repeated = await journal.append(stream, 0, [draft]);

    expect(repeated).toEqual(first);
    expect(await journal.readAll(0)).toHaveLength(1);
  });

  it('rejects an event id reused with different content', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());
    await journal.append(stream, 0, [event('evt-1')]);

    await expect(journal.append(stream, 1, [event('evt-1', 'test.changed')])).rejects.toThrow(
      'Event id evt-1 has already been used with different content',
    );
    expect(await journal.readAll(0)).toHaveLength(1);
  });

  it('does not partially append a batch when a later event is invalid', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());
    const other: EntityRef<'test', 'other'> = { kind: 'test', id: 'other' };
    const wrongStreamEvent = createEventDraft({
      ...event('evt-2'),
      eventId: 'evt-2',
      stream: other,
    });

    await expect(journal.append(stream, 0, [event('evt-1'), wrongStreamEvent])).rejects.toThrow(
      'Event stream test:other does not match append stream test:journal',
    );
    expect(await journal.readAll(0)).toEqual([]);
  });

  it('rejects an event id reused with different content in the same batch', async () => {
    const journal = new InMemoryEventJournal(new FixedClock());

    await expect(
      journal.append(stream, 0, [
        event('evt-1'),
        event('evt-1', 'test.changed', { changed: true }),
      ]),
    ).rejects.toThrow('Event id evt-1 is repeated with different content in one append');
    expect(await journal.readAll(0)).toEqual([]);
  });
});
