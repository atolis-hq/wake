import { z } from 'zod';
import {
  brandedStringSchema,
  eventEnvelopeSchema,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import {
  resourceCapability,
  resourceId,
  resourceKind,
  type ResourceId,
  type ResourceKind,
} from './identifiers.js';
import { ResourceStreamKind, type ResourceStreamRef } from './streams.js';
import type { ExternalResourceKey, ResourceCapability } from './views.js';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  type ResourceCorrelationProvenance as Provenance,
  type ResourceCorrelationRole as Role,
} from './vocabulary.js';

export const ResourceEventType = {
  ResourceDiscovered: 'resources.resource-discovered',
  ResourceRevisionObserved: 'resources.resource-revision-observed',
  WorkCorrelationEstablished: 'resources.work-correlation-established',
  WorkCorrelationRetracted: 'resources.work-correlation-retracted',
  WorkCorrelationConflicted: 'resources.work-correlation-conflicted',
  IssueCompletionObservationConsumed: 'resources.issue-completion-observation-consumed',
} as const;

export interface ResourceDiscoveredPayload {
  readonly kind: ResourceKind;
  readonly externalKey: ExternalResourceKey;
  readonly capabilities: readonly ResourceCapability[];
  readonly revision?: string | undefined;
  readonly title?: string | undefined;
}

export interface ResourceEventPayloads {
  readonly [ResourceEventType.ResourceDiscovered]: ResourceDiscoveredPayload;
  readonly [ResourceEventType.ResourceRevisionObserved]: { readonly revision: string };
  readonly [ResourceEventType.WorkCorrelationEstablished]: {
    readonly workItemId: WorkItemId;
    readonly role: Role;
    readonly provenance: Provenance;
  };
  readonly [ResourceEventType.WorkCorrelationRetracted]: { readonly workItemId: WorkItemId };
  readonly [ResourceEventType.WorkCorrelationConflicted]: {
    readonly workItemId: WorkItemId;
    readonly existingWorkItemId: WorkItemId;
  };
  readonly [ResourceEventType.IssueCompletionObservationConsumed]: {
    readonly intentEventId: string;
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
    id: brandedStringSchema(resourceId),
  })
  .strict();
const revisionSchema = z.object({ revision: z.string() }).strict();
const workItemIdSchema = brandedStringSchema(workItemId);
const eventSchema = z.discriminatedUnion('eventType', [
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.ResourceDiscovered),
    stream: streamSchema,
    payload: z
      .object({
        kind: brandedStringSchema(resourceKind),
        externalKey: z.object({ adapter: z.string(), key: z.string() }).strict(),
        capabilities: z.array(brandedStringSchema(resourceCapability)),
        revision: z.string().optional(),
        title: z.string().optional(),
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
      .object({
        workItemId: workItemIdSchema,
        role: z.enum([ResourceCorrelationRole.Primary, ResourceCorrelationRole.Secondary]),
        provenance: z.enum([
          ResourceCorrelationProvenance.ProviderObserved,
          ResourceCorrelationProvenance.AgentReported,
          ResourceCorrelationProvenance.OperatorDeclared,
        ]),
      })
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
  eventEnvelopeSchema.extend({
    eventType: z.literal(ResourceEventType.IssueCompletionObservationConsumed),
    stream: streamSchema,
    payload: z.object({ intentEventId: z.string().min(1) }).strict(),
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
