import { z } from 'zod';

import {
  brandedStringSchema,
  eventEnvelopeSchema,
  type EventEnvelope,
  type EventUnion,
} from '../../../kernel/index.js';
import {
  ResourceStreamKind,
  resourceId,
  type ResourceId,
  type ResourceStreamRef,
} from '../../../resources/index.js';

export const DeliveryIntentEventType = {
  StatusPublishRequested: 'status.publish-requested',
  ReplyPublishRequested: 'reply.publish-requested',
} as const;
export const DeliveryIntentEventNamespace = {
  Status: 'status.',
  Reply: 'reply.',
} as const;

interface PublishRequestedPayload {
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly resourceId: ResourceId;
  readonly body: string;
}

export interface DeliveryIntentEventPayloads {
  readonly [DeliveryIntentEventType.StatusPublishRequested]: PublishRequestedPayload;
  readonly [DeliveryIntentEventType.ReplyPublishRequested]: PublishRequestedPayload;
}

export type DeliveryIntentEvent = EventUnion<DeliveryIntentEventPayloads, ResourceStreamRef>;

const resourceStreamSchema = z
  .object({
    kind: z.literal(ResourceStreamKind.Resource),
    id: brandedStringSchema(resourceId),
  })
  .strict();
const payloadSchema = z
  .object({
    workflowInstanceId: z.string().min(1),
    activationId: z.string().min(1),
    resourceId: brandedStringSchema(resourceId),
    body: z.string(),
  })
  .strict();
const intentEventSchema: z.ZodType<DeliveryIntentEvent> = z
  .discriminatedUnion('eventType', [
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryIntentEventType.StatusPublishRequested),
      stream: resourceStreamSchema,
      payload: payloadSchema,
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryIntentEventType.ReplyPublishRequested),
      stream: resourceStreamSchema,
      payload: payloadSchema,
    }),
  ])
  .superRefine((event, context) => {
    if (event.stream.id !== event.payload.resourceId)
      context.addIssue({
        code: 'custom',
        path: ['payload', 'resourceId'],
        message: 'Delivery intent resource id must identify its stream',
      });
  });

export function decodeDeliveryIntentEvent(event: EventEnvelope): DeliveryIntentEvent {
  const result = intentEventSchema.safeParse(event);
  if (!result.success)
    throw new Error(
      `Invalid Delivery intent event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${result.error.message}`,
      { cause: result.error },
    );
  return result.data;
}

export function selectDeliveryIntentEvent(event: EventEnvelope): DeliveryIntentEvent | null {
  return event.eventType.startsWith(DeliveryIntentEventNamespace.Status) ||
    event.eventType.startsWith(DeliveryIntentEventNamespace.Reply)
    ? decodeDeliveryIntentEvent(event)
    : null;
}
