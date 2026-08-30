import { createEventData, type EntityRef, type EventEnvelope } from '../../src/kernel/index.js';

export function eventEnvelope<Type extends string, Payload, Stream extends EntityRef>(
  eventType: Type,
  payload: Payload,
  stream: Stream,
  position = 7,
): EventEnvelope<Type, Payload, Stream> {
  return {
    ...createEventData({
      eventId: `event-${position}`,
      eventType,
      occurredAt: '2026-07-31T12:00:00.000Z',
      correlationId: 'correlation-1',
      causationId: 'causation-1',
      actor: { kind: 'system', id: 'test' },
      source: { kind: 'internal', id: 'test' },
      stream,
      payload,
    }),
    recordedAt: '2026-07-31T12:00:01.000Z',
    sequence: position,
    globalPosition: position,
  };
}
