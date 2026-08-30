import type { EventActor, EventData, EventSource } from '../contracts/events.js';
import { causationId, correlationId, eventId } from '../contracts/identifiers.js';
import { offsetIsoTimestampSchema } from '../contracts/schema.js';

export interface EventDataInput<Type extends string, Payload> {
  readonly eventId: string;
  readonly eventType: Type;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly actor: EventActor;
  readonly source: EventSource;
  readonly payload: Payload;
}

export function createEventData<Type extends string, Payload>(
  input: EventDataInput<Type, Payload>,
): EventData<Type, Payload> {
  if (input.eventType.trim().length === 0) throw new Error('event type must not be empty');
  const occurredAt = offsetIsoTimestampSchema.safeParse(input.occurredAt);
  if (!occurredAt.success)
    throw new Error('occurred at must be a valid offset ISO timestamp', {
      cause: occurredAt.error,
    });
  assertMetadataId(input.actor.id, 'actor');
  assertMetadataId(input.source.id, 'source');
  return {
    eventId: eventId(input.eventId),
    eventType: input.eventType,
    schemaVersion: 1,
    occurredAt: occurredAt.data,
    correlationId: correlationId(input.correlationId),
    causationId: causationId(input.causationId),
    actor: input.actor,
    source: input.source,
    payload: input.payload,
  };
}

function assertMetadataId(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} id must not be empty`);
}
