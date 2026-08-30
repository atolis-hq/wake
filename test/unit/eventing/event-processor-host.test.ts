import { expect, it } from 'vitest';
import {
  EventProcessorCategory,
  EventProcessorHost,
  EventProcessorReplayPolicy,
} from '../../../src/eventing/index.js';
import { createEventDraft, type EntityRef } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  createInMemoryProcessorRunSerialiser,
} from '../../../src/persistence/index.js';
import { FakeClock } from '../../e2e/support/world.js';

it('handles selected events in journal order and advances past ignored events', async () => {
  const journal = new InMemoryEventJournal(new FakeClock());
  const stream: EntityRef<'eventing-test', 'one'> = { kind: 'eventing-test', id: 'one' };
  await journal.append(stream, 0, [event(stream, 'one')]);
  await journal.append(stream, 1, [event(stream, 'two')]);
  const checkpoints = new InMemoryCheckpointStore();
  const handled: string[] = [];
  const host = new EventProcessorHost(journal, checkpoints, createInMemoryProcessorRunSerialiser());

  const result = await host.runOnce({
    consumer: 'processor:one',
    name: 'one',
    owner: 'test',
    category: EventProcessorCategory.Projection,
    replayPolicy: EventProcessorReplayPolicy.Rebuildable,
    select: (envelope) => (envelope.eventId === 'two' ? envelope.eventId : null),
    handle: async (message, _envelope, signal) => {
      expect(signal.aborted).toBe(false);
      handled.push(message);
    },
  });

  expect(handled).toEqual(['two']);
  expect(result).toEqual({ checkpoint: 2, eventCount: 2, handledCount: 1 });
  expect(await checkpoints.load('processor:one')).toBe(2);
});

function event(stream: EntityRef, eventId: string) {
  return createEventDraft({
    eventId,
    eventType: 'eventing-test.recorded',
    occurredAt: '2026-08-30T12:00:00.000Z',
    correlationId: 'correlation',
    causationId: 'causation',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: {},
  });
}
