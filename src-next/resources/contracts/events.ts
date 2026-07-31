import { z } from 'zod';
import {
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import { resourceId, type ResourceId } from './identifiers.js';
import { ResourceStreamKind, type ResourceStreamRef } from './streams.js';
import type { ExternalResourceKey, ResourceCapability } from './views.js';

export const ResourceEventType = {
  ResourceDiscovered: 'resources.resource-discovered',
  ResourceRevisionObserved: 'resources.resource-revision-observed',
  WorkCorrelationEstablished: 'resources.work-correlation-established',
  WorkCorrelationRetracted: 'resources.work-correlation-retracted',
  WorkCorrelationConflicted: 'resources.work-correlation-conflicted',
} as const;

export interface ResourceDiscoveredPayload {
  readonly kind: string;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string | undefined;
}

export interface ResourceEventPayloads {
  readonly [ResourceEventType.ResourceDiscovered]: ResourceDiscoveredPayload;
  readonly [ResourceEventType.ResourceRevisionObserved]: { readonly revision: string };
  readonly [ResourceEventType.WorkCorrelationEstablished]: {
    readonly workItemId: WorkItemId;
    readonly role: 'primary' | 'secondary';
  };
  readonly [ResourceEventType.WorkCorrelationRetracted]: { readonly workItemId: WorkItemId };
  readonly [ResourceEventType.WorkCorrelationConflicted]: {
    readonly workItemId: WorkItemId;
    readonly existingWorkItemId: WorkItemId;
  };
}

export type ResourceEvent = EventUnion<ResourceEventPayloads, ResourceStreamRef>;
export type ResourceEventDraft = EventDraftUnion<ResourceEventPayloads, ResourceStreamRef>;

export interface ResourceEventStream {
  readonly resourceId: ResourceId;
  readonly events: readonly ResourceEvent[];
}

const streamSchema = z
  .object({
    kind: z.literal(ResourceStreamKind.Resource),
    id: z.string().transform(resourceId),
  })
  .strict();
const revisionSchema = z.object({ revision: z.string() }).strict();
const workItemIdSchema = z.string().transform(workItemId);
const eventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.ResourceDiscovered),
    stream: streamSchema,
    payload: z
      .object({
        kind: z.string(),
        externalKey: z.object({ adapter: z.string(), key: z.string() }).strict(),
        capabilities: z.array(
          z.enum([
            'commentable',
            'reviewable',
            'approvable',
            'mergeable',
            'revisioned',
            'editable',
          ]),
        ),
        revision: z.string().optional(),
      })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.ResourceRevisionObserved),
    stream: streamSchema,
    payload: revisionSchema,
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.WorkCorrelationEstablished),
    stream: streamSchema,
    payload: z
      .object({ workItemId: workItemIdSchema, role: z.enum(['primary', 'secondary']) })
      .strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.WorkCorrelationRetracted),
    stream: streamSchema,
    payload: z.object({ workItemId: workItemIdSchema }).strict(),
  }),
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.WorkCorrelationConflicted),
    stream: streamSchema,
    payload: z
      .object({
        workItemId: workItemIdSchema,
        existingWorkItemId: workItemIdSchema,
      })
      .strict(),
  }),
]);

export function decodeResourceEvent(event: EventEnvelope): ResourceEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidResourceEvent(event, result.error);
  return result.data;
}

export function selectResourceEvent(event: EventEnvelope): ResourceEvent | null {
  return event.eventType.startsWith('resources.') ? decodeResourceEvent(event) : null;
}

function invalidResourceEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Resource event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}
