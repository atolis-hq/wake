import { z } from 'zod';
import {
  brandedStringSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import { conversationId } from './identifiers.js';
import { ConversationStreamKind, type ConversationStreamRef } from './streams.js';
import type { ConversationEntryOrigin } from './views.js';
import { ConversationOriginKind } from './vocabulary.js';

export const ConversationEventType = {
  Created: 'conversation.created',
  ResourceAssociated: 'conversation.resource-associated',
  EntryRecorded: 'conversation.entry-recorded',
  EntryRevised: 'conversation.entry-revised',
  EntryTombstoned: 'conversation.entry-tombstoned',
  EntryRepresentationRecorded: 'conversation.entry-representation-recorded',
} as const;

export interface ConversationEventPayloads {
  readonly [ConversationEventType.Created]: { readonly workItemId: WorkItemId };
  readonly [ConversationEventType.ResourceAssociated]: {
    readonly resourceId: string;
    readonly threadId?: string | undefined;
  };
  readonly [ConversationEventType.EntryRecorded]: {
    readonly entryId: string;
    readonly body: string;
    readonly origin: ConversationEntryOrigin;
  };
  readonly [ConversationEventType.EntryRevised]: {
    readonly entryId: string;
    readonly body: string;
  };
  readonly [ConversationEventType.EntryTombstoned]: { readonly entryId: string };
  readonly [ConversationEventType.EntryRepresentationRecorded]: {
    readonly entryId: string;
    readonly resourceId: string;
    readonly externalId: string;
  };
}

export type ConversationEvent = EventUnion<ConversationEventPayloads, ConversationStreamRef>;

export type ConversationEventData = EventDataUnion<
  ConversationEventPayloads,
  ConversationStreamRef
>;
const stream = z
  .object({
    kind: z.literal(ConversationStreamKind.Conversation),
    id: brandedStringSchema(conversationId),
  })
  .strict();
const origin = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal(ConversationOriginKind.ControlPlane), actorId: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal(ConversationOriginKind.Agent),
      actorId: z.string().min(1),
      runId: z.string().min(1),
      stage: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ConversationOriginKind.External),
      adapter: z.string().min(1),
      actorId: z.string().min(1),
      resourceId: z.string().min(1),
      threadId: z.string().min(1),
      messageId: z.string().min(1),
      location: z
        .object({
          path: z.string().min(1),
          line: z.number().int(),
          side: z.enum(['LEFT', 'RIGHT']),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
const schema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(ConversationEventType.Created),
    stream,
    payload: z.object({ workItemId: brandedStringSchema(workItemId) }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ConversationEventType.EntryRepresentationRecorded),
    stream,
    payload: z
      .object({
        entryId: z.string().min(1),
        resourceId: z.string().min(1),
        externalId: z.string().min(1),
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ConversationEventType.ResourceAssociated),
    stream,
    payload: z
      .object({ resourceId: z.string().min(1), threadId: z.string().min(1).optional() })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ConversationEventType.EntryRecorded),
    stream,
    payload: z.object({ entryId: z.string().min(1), body: z.string(), origin }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ConversationEventType.EntryRevised),
    stream,
    payload: z.object({ entryId: z.string().min(1), body: z.string() }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ConversationEventType.EntryTombstoned),
    stream,
    payload: z.object({ entryId: z.string().min(1) }).strict(),
  }),
]);

export function decodeConversationEvent(event: EventEnvelope): ConversationEvent {
  const result = schema.safeParse(event);
  if (!result.success)
    throw new Error(`Invalid Conversation event ${event.eventId}: ${result.error.message}`);
  return result.data;
}

export function selectConversationEvent(event: EventEnvelope): ConversationEvent | null {
  return event.eventType.startsWith('conversation.') ? decodeConversationEvent(event) : null;
}
