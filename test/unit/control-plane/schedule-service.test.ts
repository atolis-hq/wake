import { EventActorKind, EventSourceKind, correlationId } from '@atolis-hq/eventing';
import { InMemoryEventJournal } from '@atolis-hq/eventing/memory';
import { expect, it } from 'vitest';
import {
  ControlEventType,
  TriggerSourceKind,
  controlPlaneStream,
  createControlPlaneEventData,
  decodeControlEvent,
  triggerProjection,
} from '../../../src/control-plane/index.js';

it('validates trigger lifecycle events before rebuilding pause and request facts', async () => {
  const journal = new InMemoryEventJournal({ now: () => new Date('2026-08-10T00:01:30.000Z') });
  const metadata = {
    occurredAt: '2026-08-10T00:01:30.000Z',
    correlationId: correlationId('trigger'),
    causationId: 'command',
    actor: { kind: EventActorKind.System, id: 'test' },
    source: { kind: EventSourceKind.Internal, id: 'trigger' },
  };
  const events = await journal.appendToStream(controlPlaneStream(), 0, [
    createControlPlaneEventData({
      ...metadata,
      eventId: 'request',
      eventType: ControlEventType.TriggerRequestRecorded,
      payload: {
        triggerId: 'test',
        coordinationKey: 'test',
        source: { kind: TriggerSourceKind.Cron, slot: '2026-08-10T00:01:00.000Z' },
        disposition: 'coalesced',
      },
    }),
    createControlPlaneEventData({
      ...metadata,
      eventId: 'pause',
      eventType: ControlEventType.TriggerPaused,
      payload: { triggerId: 'test', reason: 'operator pause' },
    }),
    createControlPlaneEventData({
      ...metadata,
      eventId: 'resume',
      eventType: ControlEventType.TriggerResumed,
      payload: { triggerId: 'test' },
    }),
  ]);
  const paused = events
    .slice(0, 2)
    .reduce(triggerProjection.project, triggerProjection.initial('global'));
  expect(paused.pauses).toEqual({ test: 'operator pause' });
  expect(paused.coalesced).toEqual({});
  const resumed = events.reduce(triggerProjection.project, triggerProjection.initial('global'));
  expect(resumed.pauses).toEqual({});
  expect(resumed.coalesced).toEqual({});
  expect(resumed.requests).toHaveLength(1);
  expect(() =>
    decodeControlEvent({ ...events[0]!, stream: { kind: 'work-item', id: 'unrelated' } }),
  ).toThrow('Invalid Control Plane event');
  expect(() =>
    decodeControlEvent({
      ...events[0]!,
      event: { ...events[0]!.event, payload: { triggerId: 'test' } },
    }),
  ).toThrow('Invalid Control Plane event');
});
