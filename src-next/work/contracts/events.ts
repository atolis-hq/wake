import { z } from 'zod';
import {
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
} as const;

export interface WorkItemLinkedPayload {
  readonly to: WorkItemId;
  readonly relation: LinkWorkItems['relation'];
}

export interface WorkEventPayloads {
  readonly [WorkEventType.ItemCreated]: { readonly objective: string };
  readonly [WorkEventType.ObjectiveRevised]: { readonly objective: string };
  readonly [WorkEventType.ItemLinked]: WorkItemLinkedPayload;
  readonly [WorkEventType.ItemClosed]: { readonly reason: string };
  readonly [WorkEventType.ItemCancelled]: { readonly reason: string };
}

export type WorkEvent = EventUnion<WorkEventPayloads, WorkItemStreamRef>;
export type WorkEventDraft = EventDraftUnion<WorkEventPayloads, WorkItemStreamRef>;

const streamSchema = z
  .object({
    kind: z.literal(WorkStreamKind.WorkItem),
    id: z.string().transform(workItemId),
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
const eventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(WorkEventType.ItemCreated),
    stream: streamSchema,
    payload: objectiveSchema,
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
        to: z.string().transform(workItemId),
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
