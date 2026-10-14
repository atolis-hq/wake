import { z } from 'zod';
import { brandedStringSchema } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';

export const artifactContextNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);

export const artifactSharedContextNameSchema = artifactContextNameSchema.refine(
  (name) => !name.startsWith('delegation:'),
  'The delegation: prefix is reserved for trusted delegation grants',
);

export const artifactRevisionReferenceSchema = z
  .object({
    workItemId: brandedStringSchema(workItemId),
    revisionId: z.string().min(1),
  })
  .strict();

export type ArtifactRevisionReference = z.infer<typeof artifactRevisionReferenceSchema>;

export const ArtifactContextProvenanceKind = {
  Trigger: 'trigger',
  Delegation: 'delegation',
} as const;

export const artifactContextProvenanceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(ArtifactContextProvenanceKind.Trigger),
      triggerId: z.string().min(1),
      invocationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal(ArtifactContextProvenanceKind.Delegation),
      delegationId: z.string().min(1),
      parentWorkItemId: brandedStringSchema(workItemId),
    })
    .strict(),
]);

export type ArtifactContextProvenance = z.infer<typeof artifactContextProvenanceSchema>;

export const ArtifactMemoryPublicationReason = {
  Advanced: 'advanced',
  Conflict: 'stale-memory-pointer',
  Failed: 'invocation-unsuccessful',
  Missing: 'missing',
  Ambiguous: 'multiple-memory-producers',
} as const;

export type ArtifactMemoryPublicationReason =
  (typeof ArtifactMemoryPublicationReason)[keyof typeof ArtifactMemoryPublicationReason];

export interface ArtifactContextEnrollment {
  readonly workItemId: ReturnType<typeof workItemId>;
  readonly provenance: ArtifactContextProvenance;
  readonly expectedMemory: ArtifactRevisionReference | null;
}

export interface ArtifactContextPublication {
  readonly publicationId: string;
  readonly workItemId: ReturnType<typeof workItemId>;
  readonly references: readonly ArtifactRevisionReference[];
  readonly memory: ArtifactRevisionReference | null;
  readonly reason: ArtifactMemoryPublicationReason;
}

export interface ArtifactContextView {
  readonly contextScope: string;
  readonly members: readonly ArtifactContextEnrollment[];
  readonly publications: readonly ArtifactContextPublication[];
  readonly memory: ArtifactRevisionReference | null;
}

/** Issued only from validated delegation; no ancestry-derived or sibling access. */
export interface ArtifactDelegationGrant {
  readonly delegationId: string;
  readonly parentWorkItemId: ReturnType<typeof workItemId>;
  readonly childWorkItemId: ReturnType<typeof workItemId>;
  readonly childReferences: readonly ArtifactRevisionReference[];
}

export const operatorInstructionsRevisionSchema = z
  .object({
    contextScope: artifactSharedContextNameSchema,
    revisionId: z.string().min(1),
    location: z.string().min(1),
    digest: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    author: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type OperatorInstructionsRevision = z.infer<typeof operatorInstructionsRevisionSchema>;

export type OperatorInstructionsDocument = OperatorInstructionsRevision & {
  readonly content: string;
};
