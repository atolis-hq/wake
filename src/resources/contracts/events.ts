import { z } from 'zod';
import {
  brandedStringSchema,
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
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
  ResourceExternalOutcome,
  type ResourceCorrelationProvenance as Provenance,
  type ResourceCorrelationRole as Role,
} from './vocabulary.js';

export const ResourceEventType = {
  ResourceDiscovered: 'resources.resource-discovered',
  ResourceRevisionObserved: 'resources.resource-revision-observed',
  WorkCorrelationEstablished: 'resources.work-correlation-established',
  WorkCorrelationRetracted: 'resources.work-correlation-retracted',
  WorkCorrelationConflicted: 'resources.work-correlation-conflicted',
  WorkCorrelationRetryPending: 'resources.work-correlation-retry-pending',
  WorkCorrelationUnresolvable: 'resources.work-correlation-unresolvable',
  ExternalOutcomeObserved: 'resources.external-outcome-observed',
  ExternalOutcomeReopened: 'resources.external-outcome-reopened',
  ExternalOutcomeConsumed: 'resources.external-outcome-consumed',
  IssueCompletionObservationConsumed: 'resources.issue-completion-observation-consumed',
  IssueCompletionObservationSuperseded: 'resources.issue-completion-observation-superseded',
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
  readonly [ResourceEventType.WorkCorrelationRetryPending]: {
    readonly attemptCount: number;
    readonly lastFailureReason: string;
  };
  readonly [ResourceEventType.WorkCorrelationUnresolvable]: {
    readonly externalKey: ExternalResourceKey;
    readonly attemptCount: number;
    readonly lastFailureReason: string;
  };
  readonly [ResourceEventType.ExternalOutcomeObserved]: {
    readonly sourceObservationId: string;
    readonly outcome: ResourceExternalOutcome;
    readonly revision: string;
  };
  readonly [ResourceEventType.ExternalOutcomeReopened]: { readonly revision: string };
  readonly [ResourceEventType.ExternalOutcomeConsumed]: { readonly sourceObservationId: string };
  readonly [ResourceEventType.IssueCompletionObservationConsumed]: {
    readonly intentEventId: string;
  };
  readonly [ResourceEventType.IssueCompletionObservationSuperseded]: {
    readonly intentEventId: string;
  };
}

export type ResourceEvent = EventUnion<ResourceEventPayloads, ResourceStreamRef>;

export type ResourceEventData = EventDataUnion<ResourceEventPayloads>;

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
const eventSchema: z.ZodType<ResourceEvent> = eventEnvelopeSchema.extend({
  event: z.discriminatedUnion('eventType', [
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.ResourceDiscovered),
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
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.ExternalOutcomeObserved),
      payload: z
        .object({
          sourceObservationId: z.string().min(1),
          outcome: z.enum([ResourceExternalOutcome.Completed, ResourceExternalOutcome.Cancelled]),
          revision: z.string().min(1),
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.ExternalOutcomeReopened),
      payload: z.object({ revision: z.string().min(1) }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.ExternalOutcomeConsumed),
      payload: z.object({ sourceObservationId: z.string().min(1) }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.WorkCorrelationRetryPending),
      payload: z
        .object({ attemptCount: z.number().int().min(1), lastFailureReason: z.string().min(1) })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.WorkCorrelationUnresolvable),
      payload: z
        .object({
          externalKey: z.object({ adapter: z.string(), key: z.string() }).strict(),
          attemptCount: z.number().int().min(1),
          lastFailureReason: z.string().min(1),
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.ResourceRevisionObserved),
      payload: revisionSchema,
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.WorkCorrelationEstablished),
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
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.WorkCorrelationRetracted),
      payload: z.object({ workItemId: workItemIdSchema }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.WorkCorrelationConflicted),
      payload: z
        .object({
          workItemId: workItemIdSchema,
          existingWorkItemId: workItemIdSchema,
        })
        .strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.IssueCompletionObservationConsumed),
      payload: z.object({ intentEventId: z.string().min(1) }).strict(),
    }),
    eventDataSchema.extend({
      eventType: z.literal(ResourceEventType.IssueCompletionObservationSuperseded),
      payload: z.object({ intentEventId: z.string().min(1) }).strict(),
    }),
  ]),
  stream: streamSchema,
});

export function decodeResourceEvent(event: EventEnvelope): ResourceEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidResourceEvent(event, result.error);
  return result.data;
}

export function selectResourceEvent(event: EventEnvelope): ResourceEvent | null {
  return event.event.eventType.startsWith('resources.') ? decodeResourceEvent(event) : null;
}

function invalidResourceEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Resource event ${event.event.eventId} at global position ${event.globalPosition} (${event.event.eventType}): ${cause.message}`,
    { cause },
  );
}
