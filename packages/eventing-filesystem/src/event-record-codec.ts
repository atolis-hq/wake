import {
  decodeEventEnvelope,
  entityRefSchema,
  eventDataSchema,
  eventEnvelopeSchema,
  type EventEnvelope,
} from '@atolis-hq/eventing';

const flatEventRecordSchema = eventDataSchema
  .omit({ payload: true })
  .extend({
    stream: entityRefSchema,
    payload: eventDataSchema.shape.payload,
    recordedAt: eventEnvelopeSchema.shape.recordedAt,
    sequence: eventEnvelopeSchema.shape.sequence,
    globalPosition: eventEnvelopeSchema.shape.globalPosition,
  })
  .strict();

export function decodeEventRecord(value: unknown): EventEnvelope {
  const record = flatEventRecordSchema.parse(value);
  return decodeEventEnvelope({
    event: {
      eventId: record.eventId,
      eventType: record.eventType,
      schemaVersion: record.schemaVersion,
      occurredAt: record.occurredAt,
      correlationId: record.correlationId,
      causationId: record.causationId,
      actor: record.actor,
      source: record.source,
      payload: record.payload,
    },
    stream: record.stream,
    recordedAt: record.recordedAt,
    sequence: record.sequence,
    globalPosition: record.globalPosition,
  });
}

export function encodeEventRecord(envelope: EventEnvelope): string {
  const valid = decodeEventEnvelope(envelope);
  const record = {
    eventId: valid.event.eventId,
    eventType: valid.event.eventType,
    schemaVersion: valid.event.schemaVersion,
    occurredAt: valid.event.occurredAt,
    correlationId: valid.event.correlationId,
    causationId: valid.event.causationId,
    actor: valid.event.actor,
    source: valid.event.source,
    stream: valid.stream,
    payload: valid.event.payload,
    recordedAt: valid.recordedAt,
    sequence: valid.sequence,
    globalPosition: valid.globalPosition,
  };
  return JSON.stringify(record);
}
