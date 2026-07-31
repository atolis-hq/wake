import { z } from 'zod';
import { eventEnvelopeSchema } from '../../kernel/index.js';
import {
  childGroupStreamSchema,
  primaryGroupStreamSchema,
  workflowStreamSchema,
} from './event-payload-schema.js';

export const workflowEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: workflowStreamSchema,
    payload,
  });

export const primaryGroupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: primaryGroupStreamSchema,
    payload,
  });

export const childGroupEnvelope = <Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) =>
  eventEnvelopeSchema.extend({
    eventType: z.literal(eventType),
    stream: childGroupStreamSchema,
    payload,
  });
