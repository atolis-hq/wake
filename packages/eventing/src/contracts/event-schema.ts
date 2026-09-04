import { z } from 'zod';
import { EventActorKind, EventSourceKind, type EventEnvelope } from './events.js';
import { causationId, correlationId, eventId } from './identifiers.js';

const offsetIsoTimestampSchema = z.iso.datetime({ offset: true });

function brandedStringSchema<Output extends string>(construct: (value: string) => Output) {
  return z.string().transform((value, context) => {
    try {
      return construct(value);
    } catch (error) {
      context.addIssue({
        code: 'custom',
        input: value,
        message: error instanceof Error ? error.message : 'Invalid branded string',
      });
      return z.NEVER;
    }
  });
}

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

export const eventDataSchema = z
  .object({
    eventId: nonEmptyString.pipe(brandedStringSchema(eventId)),
    eventType: nonEmptyString,
    schemaVersion: z.literal(1),
    occurredAt: offsetIsoTimestampSchema,
    correlationId: nonEmptyString.pipe(brandedStringSchema(correlationId)),
    causationId: nonEmptyString.pipe(brandedStringSchema(causationId)),
    actor: eventActorSchema,
    source: eventSourceSchema,
    payload: z.unknown(),
  })
  .strict();

export const eventEnvelopeSchema = z
  .object({
    event: eventDataSchema,
    stream: entityRefSchema,
    recordedAt: offsetIsoTimestampSchema,
    sequence: z.number().int().positive(),
    globalPosition: z.number().int().positive(),
  })
  .strict();

export function decodeEventEnvelope(input: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(input);
}
