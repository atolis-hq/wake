import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEventData,
  WrongExpectedSequenceError,
  type Clock,
  type EntityRef,
  type EventData,
} from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';

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
): EventData {
  return createEventData({
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
      createEventData({ ...event('evt-2'), stream: other, eventId: 'evt-2' }),
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

  it('reads the newest events before an exclusive global position', async () => {
    const journal = new InMemoryEventJournal(new FixedClock()) as InMemoryEventJournal & {
      readLatest(before?: number, limit?: number): Promise<readonly { readonly eventId: string }[]>;
    };
    await journal.append(stream, 0, [event('evt-1'), event('evt-2'), event('evt-3')]);

    expect((await journal.readLatest()).map(({ eventId }) => eventId)).toEqual([
      'evt-3',
      'evt-2',
      'evt-1',
    ]);
    expect((await journal.readLatest(3, 1)).map(({ eventId }) => eventId)).toEqual(['evt-2']);
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
    const wrongStreamEvent = createEventData({
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

  describe('changeSignal', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('notifies only when append actually records a new event, not on an idempotent replay', async () => {
      const journal = new InMemoryEventJournal(new FixedClock());
      const controller = new AbortController();

      let woke = false;
      const wait = journal.changeSignal.waitForChange(controller.signal, 1_000).then(() => {
        woke = true;
      });
      await journal.append(stream, 0, [event('evt-1')]);
      await wait;

      expect(woke).toBe(true);

      let wokeAgain = false;
      const secondWait = journal.changeSignal.waitForChange(controller.signal, 1_000).then(() => {
        wokeAgain = true;
      });
      // Resubmitting the exact same already-recorded draft is a no-op append.
      await journal.append(stream, 0, [event('evt-1')]);
      await vi.advanceTimersByTimeAsync(1);
      expect(wokeAgain).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      await secondWait;
      expect(wokeAgain).toBe(true);
    });

    it('wakes multiple independent subscribers off one append, each catching up to their own checkpoint', async () => {
      const journal = new InMemoryEventJournal(new FixedClock());
      await journal.append(stream, 0, [event('evt-1')]);
      const firstCheckpoint = await journal.latestGlobalPosition();
      await journal.append(stream, 1, [event('evt-2')]);
      const secondCheckpoint = await journal.latestGlobalPosition();

      const firstController = new AbortController();
      const secondController = new AbortController();
      const firstWait = journal.changeSignal.waitForChange(firstController.signal, 1_000);
      const secondWait = journal.changeSignal.waitForChange(secondController.signal, 1_000);

      await journal.append(stream, 2, [event('evt-3')]);
      await Promise.all([firstWait, secondWait]);

      expect((await journal.readAll(firstCheckpoint)).map((e) => e.eventId)).toEqual([
        'evt-2',
        'evt-3',
      ]);
      expect((await journal.readAll(secondCheckpoint)).map((e) => e.eventId)).toEqual(['evt-3']);
    });
  });

  describe('waitForEventsAfter', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns immediately when the durable tail is already newer than the supplied position', async () => {
      const journal = new InMemoryEventJournal(new FixedClock());
      await journal.append(stream, 0, [event('evt-1')]);

      let resolved = false;
      const wait = journal.waitForEventsAfter(0, new AbortController().signal, 10_000).then(() => {
        resolved = true;
      });
      await wait;
      expect(resolved).toBe(true);
    });

    it('returns when aborted while no newer durable event exists', async () => {
      const journal = new InMemoryEventJournal(new FixedClock());
      const controller = new AbortController();
      const wait = journal.waitForEventsAfter(0, controller.signal, 10_000);

      controller.abort();

      await expect(wait).resolves.toBeUndefined();
    });

    it('returns after the fallback when no append or abort occurs', async () => {
      const journal = new InMemoryEventJournal(new FixedClock());
      let resolved = false;
      const wait = journal.waitForEventsAfter(0, new AbortController().signal, 1_000).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await wait;
      expect(resolved).toBe(true);
    });

    it('does not sleep through an append that arrives while a consumer is processing', async () => {
      const journal = new InMemoryEventJournal(new FixedClock());
      await journal.append(stream, 0, [event('evt-1')]);
      const checkpoint = await journal.latestGlobalPosition();

      // The consumer has already read event 1 and is still processing it.
      await journal.append(stream, 1, [event('evt-2')]);

      let resolved = false;
      const wait = journal
        .waitForEventsAfter(checkpoint, new AbortController().signal, 10_000)
        .then(() => {
          resolved = true;
        });
      await wait;
      expect(resolved).toBe(true);
      expect((await journal.readAll(checkpoint)).map((entry) => entry.eventId)).toEqual(['evt-2']);
    });
  });
});
