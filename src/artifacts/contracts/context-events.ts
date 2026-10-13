import {
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '@atolis-hq/eventing';
import { z } from 'zod';
import { brandedStringSchema } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import {
  artifactContextNameSchema,
  artifactContextProvenanceSchema,
  ArtifactMemoryPublicationReason,
  artifactRevisionReferenceSchema,
  type ArtifactContextEnrollment,
  type ArtifactContextPublication,
  type ArtifactDelegationGrant,
} from './context.js';
import { ArtifactStreamKind, type ArtifactContextStreamRef } from './streams.js';

export const ArtifactContextEventType = {
  Enrolled: 'artifact-context.enrolled',
  Published: 'artifact-context.published',
  Delegated: 'artifact-context.delegated',
} as const;

export interface ArtifactContextEventPayloads {
  readonly [ArtifactContextEventType.Enrolled]: {
    readonly contextScope: string;
  } & ArtifactContextEnrollment;
  readonly [ArtifactContextEventType.Published]: {
    readonly contextScope: string;
  } & ArtifactContextPublication;
  readonly [ArtifactContextEventType.Delegated]: {
    readonly contextScope: string;
  } & ArtifactDelegationGrant;
}

export type ArtifactContextEvent = EventUnion<
  ArtifactContextEventPayloads,
  ArtifactContextStreamRef
>;

export type ArtifactContextEventData = EventDataUnion<ArtifactContextEventPayloads>;
const common = z.object({ contextScope: artifactContextNameSchema }).strict();
const stream = z
  .object({ kind: z.literal(ArtifactStreamKind.Context), id: artifactContextNameSchema })
  .strict();
const schema = z.union([
  eventEnvelopeSchema.extend({
    stream,
    event: eventDataSchema.extend({
      eventType: z.literal(ArtifactContextEventType.Enrolled),
      payload: common.extend({
        workItemId: brandedStringSchema(workItemId),
        provenance: artifactContextProvenanceSchema,
        expectedMemory: artifactRevisionReferenceSchema.nullable(),
      }),
    }),
  }),
  eventEnvelopeSchema.extend({
    stream,
    event: eventDataSchema.extend({
      eventType: z.literal(ArtifactContextEventType.Published),
      payload: common.extend({
        publicationId: z.string().min(1),
        workItemId: brandedStringSchema(workItemId),
        references: z.array(artifactRevisionReferenceSchema),
        memory: artifactRevisionReferenceSchema.nullable(),
        reason: z.enum(Object.values(ArtifactMemoryPublicationReason)),
      }),
    }),
  }),
  eventEnvelopeSchema.extend({
    stream,
    event: eventDataSchema.extend({
      eventType: z.literal(ArtifactContextEventType.Delegated),
      payload: common.extend({
        delegationId: z.string().min(1),
        parentWorkItemId: brandedStringSchema(workItemId),
        childWorkItemId: brandedStringSchema(workItemId),
        childReferences: z.array(artifactRevisionReferenceSchema),
      }),
    }),
  }),
]);

export function decodeArtifactContextEvent(event: EventEnvelope): ArtifactContextEvent {
  const decoded = schema.parse(event);
  if (decoded.stream.id !== decoded.event.payload.contextScope)
    throw new Error('Artifact context event belongs to another scope');
  return decoded;
}

export function selectArtifactContextEvent(event: EventEnvelope): ArtifactContextEvent | null {
  return event.event.eventType.startsWith('artifact-context.')
    ? decodeArtifactContextEvent(event)
    : null;
}
