import { z } from 'zod';
import {
  brandedStringSchema,
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
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
  ItemFrozen: 'work.item-frozen',
  ItemUnfrozen: 'work.item-unfrozen',
  ItemDeleted: 'work.item-deleted',
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
  readonly [WorkEventType.ItemFrozen]: Readonly<Record<never, never>>;
  readonly [WorkEventType.ItemUnfrozen]: Readonly<Record<never, never>>;
  readonly [WorkEventType.ItemDeleted]: Readonly<Record<never, never>>;
}

export type WorkEvent = EventUnion<WorkEventPayloads, WorkItemStreamRef>;

export type WorkEventData = EventDataUnion<WorkEventPayloads>;

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
const eventSchema: z.ZodType<WorkEvent> = eventEnvelopeSchema.extend({
  event: z.discriminatedUnion('eventType', [
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemCreated),
      payload: itemCreatedSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ObjectiveRevised),
      payload: objectiveSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemLinked),
      payload: z
        .object({
          to: brandedStringSchema(workItemId),
          relation: z.enum(['relates-to', 'parent-of', 'child-of']),
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemClosed),
      payload: reasonSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemCancelled),
      payload: reasonSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.AutoApprovalGranted),
      payload: consentSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.AutoApprovalRevoked),
      payload: consentSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemFrozen),
      payload: consentSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemUnfrozen),
      payload: consentSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(WorkEventType.ItemDeleted),
      payload: consentSchema,
    }),
  ]),
  stream: streamSchema,
});

export function decodeWorkEvent(event: EventEnvelope): WorkEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidWorkEvent(event, result.error);
  return result.data;
}

export function selectWorkEvent(event: EventEnvelope): WorkEvent | null {
  return event.event.eventType.startsWith('work.') ? decodeWorkEvent(event) : null;
}

function invalidWorkEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Work event ${event.event.eventId} at global position ${event.globalPosition} (${event.event.eventType}): ${cause.message}`,
    { cause },
  );
}
