import {
  createEventData,
  InProcessJournalChangeSignal,
  type EventData,
  type EventEnvelope,
  type EventJournal,
} from '@atolis-hq/eventing';
import { expect, it } from 'vitest';
import { resolveWakePaths } from '../../../src/bootstrap/index.js';
import { composePersistence } from '../../../src/bootstrap/persistence-composition.js';
import { type EntityRef } from '../../../src/kernel/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('serializes appends shared by resident runtime loops', async () => {
  const { journal, expectedSequences } = concurrentAppendRejectingJournal();
  const persistence = composePersistence(resolveWakePaths('C:/wake-home'), new FakeClock(), {
    journal,
  });

  const [first, second] = await Promise.all([
    persistence.journal.appendToStream(stream, 0, [event('event-1')]),
    persistence.journal.appendToStream(stream, 1, [event('event-2')]),
  ]);

  expect(first).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ eventId: 'event-1' }),
      sequence: 1,
    }),
  ]);
  expect(second).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ eventId: 'event-2' }),
      sequence: 2,
    }),
  ]);
  expect(expectedSequences).toEqual([0, 1]);
});

const stream: EntityRef<'test', 'serialization'> = { kind: 'test', id: 'serialization' };

function event(eventId: string): EventData {
  return createEventData({
    eventId,
    eventType: 'test.appended',
    occurredAt: '2026-08-30T00:00:00.000Z',
    correlationId: 'correlation-1',
    causationId: 'causation-1',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    payload: { eventId },
  });
}

function concurrentAppendRejectingJournal(): {
  readonly journal: EventJournal;
  readonly expectedSequences: readonly number[];
} {
  let appendInFlight = false;
  let globalPosition = 0;
  const expectedSequences: number[] = [];
  return {
    expectedSequences,
    journal: {
      async appendToStream(
        appendStream,
        expectedSequence,
        events,
      ): Promise<readonly EventEnvelope[]> {
        if (events.length === 0) throw new Error('appendToStream requires at least one event');
        if (appendInFlight) throw new Error('concurrent append');
        appendInFlight = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        appendInFlight = false;
        expectedSequences.push(expectedSequence);
        return events.map((event, index) => ({
          event,
          stream: appendStream,
          recordedAt: '2026-08-30T00:00:00.000Z',
          sequence: expectedSequence + index + 1,
          globalPosition: ++globalPosition,
        }));
      },
      async readStream() {
        return [];
      },
      async readAll() {
        return [];
      },
      async latestGlobalPosition() {
        return globalPosition;
      },
      async waitForEventsAfter() {},
      changeSignal: new InProcessJournalChangeSignal(),
    },
  };
}
