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
  AgentRunPublishRequested: 'agent-run.publish-requested',
} as const;

export const DeliveryIntentEventNamespace = { Status: 'status.', Reply: 'reply.' } as const;

interface PublishRequestedPayload {
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly resourceId: ResourceId;
  readonly body: string;
}

export interface AgentRunPublicationReport {
  readonly runId: string;
  readonly stage?: string | undefined;
  readonly runner?: string | undefined;
  readonly runnerPool?: string | undefined;
  readonly cli?: string | undefined;
  readonly model?: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly displayBody: string;
  readonly outcome: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED' | 'NEEDS_CLARIFICATION';
  readonly sessionId?: string | undefined;
  readonly workspacePath?: string | undefined;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly awaitingApproval?: boolean | undefined;
  readonly watchGateVerdict?: { readonly runId: string } | undefined;
}

interface AgentRunPublishRequestedPayload {
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly resourceId: ResourceId;
  readonly report: AgentRunPublicationReport;
}

export interface DeliveryIntentEventPayloads {
  readonly [DeliveryIntentEventType.StatusPublishRequested]: PublishRequestedPayload;
  readonly [DeliveryIntentEventType.ReplyPublishRequested]: PublishRequestedPayload;
  readonly [DeliveryIntentEventType.AgentRunPublishRequested]: AgentRunPublishRequestedPayload;
}

export type DeliveryIntentEvent = EventUnion<DeliveryIntentEventPayloads, ResourceStreamRef>;
const resourceStreamSchema = z
  .object({ kind: z.literal(ResourceStreamKind.Resource), id: brandedStringSchema(resourceId) })
  .strict();
const publishSchema = z
  .object({
    workflowInstanceId: z.string().min(1),
    activationId: z.string().min(1),
    resourceId: brandedStringSchema(resourceId),
    body: z.string(),
  })
  .strict();
const reportSchema = z
  .object({
    runId: z.string().min(1),
    stage: z.string().min(1).optional(),
    runner: z.string().min(1).optional(),
    runnerPool: z.string().min(1).optional(),
    cli: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    displayBody: z.string(),
    outcome: z.enum(['DONE', 'REJECTED', 'BLOCKED', 'FAILED', 'NEEDS_CLARIFICATION']),
    sessionId: z.string().min(1).optional(),
    workspacePath: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    awaitingApproval: z.boolean().optional(),
    watchGateVerdict: z
      .object({ runId: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
const agentSchema = z
  .object({
    workflowInstanceId: z.string().min(1),
    activationId: z.string().min(1),
    resourceId: brandedStringSchema(resourceId),
    report: reportSchema,
  })
  .strict();
const intentEventSchema: z.ZodType<DeliveryIntentEvent> = z
  .discriminatedUnion('eventType', [
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryIntentEventType.StatusPublishRequested),
      stream: resourceStreamSchema,
      payload: publishSchema,
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryIntentEventType.ReplyPublishRequested),
      stream: resourceStreamSchema,
      payload: publishSchema,
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(DeliveryIntentEventType.AgentRunPublishRequested),
      stream: resourceStreamSchema,
      payload: agentSchema,
    }),
  ])
  .superRefine((event, ctx) => {
    if (event.stream.id !== event.payload.resourceId)
      ctx.addIssue({
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
    event.eventType.startsWith(DeliveryIntentEventNamespace.Reply) ||
    event.eventType === DeliveryIntentEventType.AgentRunPublishRequested
    ? decodeDeliveryIntentEvent(event)
    : null;
}
