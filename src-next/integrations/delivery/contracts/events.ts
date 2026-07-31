import { z } from 'zod';
import {
  brandedStringSchema,
  eventId,
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventId,
  type EventUnion,
} from '../../../kernel/index.js';
import { IntegrationStreamKind, type DeliveryStreamRef } from '../../contracts/streams.js';
import { DeliveryResultKind } from './vocabulary.js';

export const DeliveryEventType = {
  AttemptStarted: 'delivery.attempt-started',
  Confirmed: 'delivery.confirmed',
  Failed: 'delivery.failed',
  Ambiguous: 'delivery.ambiguous',
  Reconciled: 'delivery.reconciled',
} as const;
export const DeliveryEventNamespace = 'delivery.' as const;

export interface DeliveryEventCorrelation {
  readonly intentEventId: EventId;
  readonly intentGlobalPosition: number;
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly occurrenceOrdinal: number;
}

export interface DeliveryEventPayloads {
  readonly [DeliveryEventType.AttemptStarted]: DeliveryEventCorrelation;
  readonly [DeliveryEventType.Confirmed]: DeliveryEventCorrelation & {
    readonly externalId: string;
  };
  readonly [DeliveryEventType.Failed]: DeliveryEventCorrelation & {
    readonly code: string;
    readonly message: string;
  };
  readonly [DeliveryEventType.Ambiguous]: DeliveryEventCorrelation & {
    readonly reconciliationKey: string;
  };
  readonly [DeliveryEventType.Reconciled]: DeliveryEventCorrelation &
    (
      | {
          readonly result: typeof DeliveryResultKind.Confirmed;
          readonly externalId: string;
        }
      | {
          readonly result: typeof DeliveryResultKind.NotFound | typeof DeliveryResultKind.Unknown;
          readonly externalId?: never;
        }
    );
}

export type DeliveryEvent = EventUnion<DeliveryEventPayloads, DeliveryStreamRef>;
export type DeliveryEventDraft = EventDraftUnion<DeliveryEventPayloads, DeliveryStreamRef>;

const correlationSchema = z
  .object({
    intentEventId: brandedStringSchema(eventId),
    intentGlobalPosition: z.number().int().positive(),
    workflowInstanceId: z.string().min(1),
    activationId: z.string().min(1),
    occurrenceOrdinal: z.number().int().positive(),
  })
  .strict();
const deliveryStreamSchema = z
  .object({
    kind: z.literal(IntegrationStreamKind.Delivery),
    id: brandedStringSchema(eventId),
  })
  .strict();
const reconciledPayloadSchema = z.discriminatedUnion('result', [
  correlationSchema.extend({
    result: z.literal(DeliveryResultKind.Confirmed),
    externalId: z.string().min(1),
  }),
  correlationSchema.extend({ result: z.literal(DeliveryResultKind.NotFound) }),
  correlationSchema.extend({ result: z.literal(DeliveryResultKind.Unknown) }),
]);
const eventSchema: z.ZodType<DeliveryEvent> = z
  .discriminatedUnion('eventType', [
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryEventType.AttemptStarted),
      stream: deliveryStreamSchema,
      payload: correlationSchema,
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryEventType.Confirmed),
      stream: deliveryStreamSchema,
      payload: correlationSchema.extend({ externalId: z.string().min(1) }),
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryEventType.Failed),
      stream: deliveryStreamSchema,
      payload: correlationSchema.extend({ code: z.string().min(1), message: z.string().min(1) }),
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryEventType.Ambiguous),
      stream: deliveryStreamSchema,
      payload: correlationSchema.extend({ reconciliationKey: z.string().min(1) }),
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryEventType.Reconciled),
      stream: deliveryStreamSchema,
      payload: reconciledPayloadSchema,
    }),
  ])
  .superRefine((event, context) => {
    if (event.stream.id !== event.payload.intentEventId)
      context.addIssue({
        code: 'custom',
        path: ['payload', 'intentEventId'],
        message: 'Delivery intent payload id must identify its stream',
      });
  });
export function decodeDeliveryEvent(event: EventEnvelope): DeliveryEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success)
    throw new Error(
      `Invalid Delivery event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${result.error.message}`,
      { cause: result.error },
    );
  return result.data;
}
export function selectDeliveryEvent(event: EventEnvelope): DeliveryEvent | null {
  return event.eventType.startsWith(DeliveryEventNamespace) ? decodeDeliveryEvent(event) : null;
}
