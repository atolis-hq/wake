import {
  eventDataSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '@atolis-hq/eventing';
import { z } from 'zod';
import { brandedStringSchema } from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import { artifactWorkItemId } from './identifiers.js';
import { artifactPath } from './paths.js';
import { ArtifactStreamKind, type ArtifactWorkItemStreamRef } from './streams.js';

export const ArtifactEventType = {
  RevisionStaged: 'artifact.revision-staged',
  TombstoneStaged: 'artifact.tombstone-staged',
} as const;

export interface ArtifactEventPayloads {
  readonly [ArtifactEventType.RevisionStaged]: {
    readonly workItemId: WorkItemId;
    readonly revisionId: string;
    readonly producer: string;
    readonly path: string;
    readonly runId: string;
    readonly activationId: string;
    readonly location: string;
    readonly digest: string;
    readonly byteLength: number;
    readonly mediaType?: string | undefined;
  };
  readonly [ArtifactEventType.TombstoneStaged]: {
    readonly workItemId: WorkItemId;
    readonly revisionId: string;
    readonly producer: string;
    readonly path: string;
    readonly runId: string;
    readonly activationId: string;
  };
}

export type ArtifactEvent = EventUnion<ArtifactEventPayloads, ArtifactWorkItemStreamRef>;

export type ArtifactEventData = EventDataUnion<ArtifactEventPayloads>;

const stream = z
  .object({
    kind: z.literal(ArtifactStreamKind.WorkItem),
    id: brandedStringSchema(artifactWorkItemId),
  })
  .strict();
const staged = z
  .object({
    workItemId: brandedStringSchema(workItemId),
    revisionId: z.string().min(1),
    producer: z.string().min(1),
    path: z.string().transform(artifactPath),
    runId: z.string().min(1),
    activationId: z.string().min(1),
  })
  .strict();
const schema = z.union([
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ArtifactEventType.RevisionStaged),
      payload: staged.extend({
        location: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().nonnegative(),
        mediaType: z.string().min(1).optional(),
      }),
    }),
    stream,
  }),
  eventEnvelopeSchema.extend({
    event: eventDataSchema.extend({
      eventType: z.literal(ArtifactEventType.TombstoneStaged),
      payload: staged,
    }),
    stream,
  }),
]);

export function decodeArtifactEvent(event: EventEnvelope): ArtifactEvent {
  const result = schema.safeParse(event);
  if (!result.success)
    throw new Error(`Invalid Artifact event ${event.event.eventId}: ${result.error.message}`);
  return result.data;
}

export function selectArtifactEvent(event: EventEnvelope): ArtifactEvent | null {
  return event.event.eventType.startsWith('artifact.') ? decodeArtifactEvent(event) : null;
}
