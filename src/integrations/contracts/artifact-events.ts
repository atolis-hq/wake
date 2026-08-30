import { z } from 'zod';
import { activationId } from '../../activities/index.js';
import {
  brandedStringSchema,
  eventEnvelopeSchema,
  type EventDataUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { workflowInstanceId } from '../../orchestration/index.js';
import { resourceKind, type ResourceKind } from '../../resources/index.js';
import {
  ArtifactVerificationStatus,
  type ArtifactVerificationStatus as VerificationStatus,
} from './artifact-vocabulary.js';
import { adapterId, type AdapterId } from './identifiers.js';
import { IntegrationStreamKind, integrationStream, type IntegrationStreamRef } from './streams.js';

export const ArtifactEventType = {
  VerificationUnresolved: 'integration.artifact-verification-unresolved',
} as const;

export interface ArtifactVerificationUnresolvedPayload {
  readonly workflowInstanceId: ReturnType<typeof workflowInstanceId>;
  readonly activationId: ReturnType<typeof activationId>;
  readonly artifact: {
    readonly kind: ResourceKind;
    readonly externalKey: { readonly adapter: AdapterId; readonly key: string };
  };
  readonly status: VerificationStatus;
  readonly attempt: number;
  readonly escalated: boolean;
}

export interface ArtifactEventPayloads {
  readonly [ArtifactEventType.VerificationUnresolved]: ArtifactVerificationUnresolvedPayload;
}

export type ArtifactEvent = EventUnion<ArtifactEventPayloads, IntegrationStreamRef>;

export type ArtifactEventData = EventDataUnion<ArtifactEventPayloads, IntegrationStreamRef>;

const schema: z.ZodType<ArtifactEvent> = eventEnvelopeSchema
  .extend({
    eventType: z.literal(ArtifactEventType.VerificationUnresolved),
    stream: z
      .object({
        kind: z.literal(IntegrationStreamKind.Integration),
        id: brandedStringSchema(adapterId),
      })
      .strict(),
    payload: z
      .object({
        workflowInstanceId: brandedStringSchema(workflowInstanceId),
        activationId: brandedStringSchema(activationId),
        artifact: z
          .object({
            kind: brandedStringSchema(resourceKind),
            externalKey: z
              .object({ adapter: brandedStringSchema(adapterId), key: z.string().min(1) })
              .strict(),
          })
          .strict(),
        status: z.enum([ArtifactVerificationStatus.Failed, ArtifactVerificationStatus.Ambiguous]),
        attempt: z.number().int().positive(),
        escalated: z.boolean(),
      })
      .strict(),
  })
  .superRefine((event, context) => {
    if (event.stream.id !== event.payload.artifact.externalKey.adapter)
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Artifact adapter must identify its integration stream',
      });
  });

export function decodeArtifactEvent(event: EventEnvelope): ArtifactEvent {
  const result = schema.safeParse(event);
  if (!result.success)
    throw new Error(`Invalid artifact event ${event.eventId}: ${result.error.message}`, {
      cause: result.error,
    });
  return result.data;
}

export function artifactVerificationUnresolvedDraft(
  input: Omit<ArtifactEventData, 'schemaVersion'>,
): ArtifactEventData {
  return { ...input, schemaVersion: 1 };
}

export function artifactIntegrationStream(adapter: AdapterId): IntegrationStreamRef {
  return integrationStream(adapter);
}
