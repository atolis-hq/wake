import { z } from 'zod';
import {
  brandedStringSchema,
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import type { LinkWorkItems } from './commands.js';
import { workItemId, type WorkItemId } from './identifiers.js';
import { WorkStreamKind, type WorkItemStreamRef } from './streams.js';

export const WorkEventType = {
  ItemCreated: 'work.item-created',
  ObjectiveRevised: 'work.objective-revised',
  ItemLinked: 'work.item-linked',
  ItemClosed: 'work.item-closed',
  ItemCancelled: 'work.item-cancelled',
  AutoApprovalGranted: 'work.auto-approval-granted',
  AutoApprovalRevoked: 'work.auto-approval-revoked',
} as const;

export interface WorkItemLinkedPayload {
  readonly to: WorkItemId;
  readonly relation: LinkWorkItems['relation'];
}

export interface WorkItemCreatedPayload {
  readonly objective: string;
  // Optional so events recorded before tags existed still decode.
  readonly tags?: readonly string[] | undefined;
}

export interface WorkEventPayloads {
  readonly [WorkEventType.ItemCreated]: WorkItemCreatedPayload;
  readonly [WorkEventType.ObjectiveRevised]: { readonly objective: string };
  readonly [WorkEventType.ItemLinked]: WorkItemLinkedPayload;
  readonly [WorkEventType.ItemClosed]: { readonly reason: string };
  readonly [WorkEventType.ItemCancelled]: { readonly reason: string };
  readonly [WorkEventType.AutoApprovalGranted]: Readonly<Record<never, never>>;
  readonly [WorkEventType.AutoApprovalRevoked]: Readonly<Record<never, never>>;
}

export type WorkEvent = EventUnion<WorkEventPayloads, WorkItemStreamRef>;
export type WorkEventDraft = EventDraftUnion<WorkEventPayloads, WorkItemStreamRef>;

const streamSchema = z
  .object({
    kind: z.literal(WorkStreamKind.WorkItem),
    id: brandedStringSchema(workItemId),
  })
  .strict();
const objectiveSchema = z
  .object({
    objective: z.string().refine((objective) => objective.trim().length > 0, {
      message: 'objective must not be empty',
    }),
  })
  .strict();
const reasonSchema = z.object({ reason: z.string() }).strict();
const consentSchema = z.object({}).strict();
const itemCreatedSchema = objectiveSchema.extend({
  tags: z.array(z.string().trim().min(1)).readonly().optional(),
});
const eventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.ItemCreated),
    stream: streamSchema,
    payload: itemCreatedSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.ObjectiveRevised),
    stream: streamSchema,
    payload: objectiveSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.ItemLinked),
    stream: streamSchema,
    payload: z
      .object({
        to: brandedStringSchema(workItemId),
        relation: z.enum(['relates-to', 'parent-of', 'child-of']),
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.ItemClosed),
    stream: streamSchema,
    payload: reasonSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.ItemCancelled),
    stream: streamSchema,
    payload: reasonSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.AutoApprovalGranted),
    stream: streamSchema,
    payload: consentSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.AutoApprovalRevoked),
    stream: streamSchema,
    payload: consentSchema,
  }),
]);

export function decodeWorkEvent(event: EventEnvelope): WorkEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidWorkEvent(event, result.error);
  return result.data;
}

export function selectWorkEvent(event: EventEnvelope): WorkEvent | null {
  return event.eventType.startsWith('work.') ? decodeWorkEvent(event) : null;
}

function invalidWorkEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Work event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}
