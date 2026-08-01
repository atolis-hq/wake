import { z } from 'zod';
import { EventActorKind, EventSourceKind, type EventEnvelope } from './events.js';
import { causationId, correlationId, eventId } from './identifiers.js';
import { brandedStringSchema, offsetIsoTimestampSchema } from './schema.js';

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be empty',
});

export const eventActorSchema = z
  .object({
    kind: z.enum([
      EventActorKind.System,
      EventActorKind.Operator,
      EventActorKind.Agent,
      EventActorKind.Integration,
    ]),
    id: nonEmptyString,
  })
  .strict();

export const eventSourceSchema = z
  .object({
    kind: z.enum([EventSourceKind.Internal, EventSourceKind.Adapter]),
    id: nonEmptyString,
  })
  .strict();

export const entityRefSchema = z
  .object({
    kind: nonEmptyString,
    id: nonEmptyString,
  })
  .strict();

export const eventDraftSchema = z
  .object({
    eventId: nonEmptyString.pipe(brandedStringSchema(eventId)),
    eventType: nonEmptyString,
    schemaVersion: z.literal(1),
    occurredAt: offsetIsoTimestampSchema,
    correlationId: nonEmptyString.pipe(brandedStringSchema(correlationId)),
    causationId: nonEmptyString.pipe(brandedStringSchema(causationId)),
    actor: eventActorSchema,
    source: eventSourceSchema,
    stream: entityRefSchema,
    payload: z.unknown(),
  })
  .strict();

export const eventEnvelopeSchema = eventDraftSchema
  .extend({
    recordedAt: offsetIsoTimestampSchema,
    sequence: z.number().int().positive(),
    globalPosition: z.number().int().positive(),
  })
  .strict();

export function decodeEventEnvelope(input: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(input);
}
