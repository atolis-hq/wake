import { z } from 'zod';
import { brandedStringSchema } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import { delegationResultSchema } from './delegation.js';
import type { StageName } from './identifiers.js';
import {
  CandidateSourceKind,
  MaintenanceKind,
  QaVerdict,
  type DeliveryRejection,
} from './vocabulary.js';

const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);

export const deliveryOutputKeySchema = z
  .object({ childWorkItemId: brandedStringSchema(workItemId), outputName: z.string().min(1) })
  .strict();

export type DeliveryOutputKey = z.infer<typeof deliveryOutputKeySchema>;

export const deliverySelectionEntrySchema = z
  .object({
    /** The original required assignment this entry covers. */
    cohortId: z.string().min(1),
    assignmentId: z.string().min(1),
    output: deliveryOutputKeySchema,
    /** Required exactly when the output is from a replacement; the output selected until now. */
    replaces: deliveryOutputKeySchema.optional(),
  })
  .strict();

/** Agent input: the complete current selection, so an omitted requirement cannot be waived. */
export const deliverySelectionCommandSchema = z
  .object({
    requestId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    entries: z.array(deliverySelectionEntrySchema).min(1),
  })
  .strict();

export type DeliverySelectionCommand = z.infer<typeof deliverySelectionCommandSchema>;

const deliveryOutputSchema = delegationResultSchema.shape.outputs.element;

export const selectedEntrySchema = z
  .object({
    cohortId: z.string().min(1),
    assignmentId: z.string().min(1),
    childWorkItemId: brandedStringSchema(workItemId),
    output: deliveryOutputSchema,
    replaces: deliveryOutputKeySchema.optional(),
  })
  .strict();

export type SelectedEntry = z.infer<typeof selectedEntrySchema>;

export const deliverySelectionSchema = z
  .object({
    requestId: z.string().min(1),
    revision: z.number().int().positive(),
    entries: z.array(selectedEntrySchema).min(1),
  })
  .strict();

export type DeliverySelection = z.infer<typeof deliverySelectionSchema>;

export const candidateSourceInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal(CandidateSourceKind.Output),
      /** The tip; `includes` declares the other selected outputs of an intentional stack. */
      tip: deliveryOutputKeySchema,
      includes: z.array(deliveryOutputKeySchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(CandidateSourceKind.RetainedRef),
      ref: z.string().min(1),
      revision,
      contributions: z.array(deliveryOutputKeySchema).min(1),
    })
    .strict(),
]);

export const deliveryCandidateCommandSchema = z
  .object({
    candidateId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    selectionRevision: z.number().int().positive(),
    repositories: z
      .array(
        z.object({ resourceId: z.string().min(1), source: candidateSourceInputSchema }).strict(),
      )
      .min(1),
    /** The configured environment and test recipe QA must follow. */
    recipe: z.string().trim().min(1).optional(),
  })
  .strict();

export type DeliveryCandidateCommand = z.infer<typeof deliveryCandidateCommandSchema>;

export const candidateRepositorySchema = z
  .object({
    resourceId: z.string().min(1),
    revision,
    pullRequestBase: z.string().min(1),
    source: z.union([
      z
        .object({ kind: z.literal(CandidateSourceKind.Output), tip: deliveryOutputKeySchema })
        .strict(),
      z
        .object({ kind: z.literal(CandidateSourceKind.RetainedRef), ref: z.string().min(1) })
        .strict(),
    ]),
    contributions: z.array(deliveryOutputKeySchema).min(1),
  })
  .strict();

export const deliveryCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    selectionRevision: z.number().int().positive(),
    repositories: z.array(candidateRepositorySchema).min(1),
    /**
     * The exact change subjects this candidate was built from. Maintenance that replaces any of
     * them makes the candidate, and QA of it, historical rather than current.
     */
    subjects: z
      .array(
        z
          .object({
            childWorkItemId: brandedStringSchema(workItemId),
            outputName: z.string().min(1),
            revision,
            pullRequestBase: z.string().min(1),
            baseRevision: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    /** Non-change outputs (plans, evidence) the candidate was selected with. */
    context: z.array(deliveryOutputKeySchema),
    criteria: z.array(z.string().min(1)),
    recipe: z.string().min(1).optional(),
  })
  .strict();

export type DeliveryCandidate = z.infer<typeof deliveryCandidateSchema>;

export const deliveryQaCommandSchema = z
  .object({
    qaId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    candidateId: z.string().min(1),
    verdict: z.enum(QaVerdict),
    /** The exact revision per repository the QA run checked; must equal the candidate's set. */
    revisions: z.array(z.object({ resourceId: z.string().min(1), revision }).strict()).min(1),
    environment: z
      .object({ recipe: z.string().min(1).optional(), available: z.boolean() })
      .strict(),
    findings: z.array(z.string().trim().min(1)).default([]),
    evidence: z
      .array(
        z
          .object({ workItemId: brandedStringSchema(workItemId), revisionId: z.string().min(1) })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type DeliveryQaCommand = z.infer<typeof deliveryQaCommandSchema>;

export const deliveryQaSchema = deliveryQaCommandSchema
  .extend({
    /** Set when this failure used the last descendant slot: the parent must escalate. */
    exhausted: z.boolean().optional(),
    runId: z.string().min(1).optional(),
    activationId: z.string().min(1).optional(),
  })
  .strict();

export type DeliveryQa = z.infer<typeof deliveryQaSchema>;

const subjectState = z
  .object({
    revision,
    pullRequestBase: z.string().min(1),
    baseRevision: z.string().min(1).optional(),
  })
  .strict();

/** Agent input: what it did to one selected change, for Wake to verify against the provider. */
export const deliveryMaintenanceCommandSchema = z
  .object({
    maintenanceId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    target: deliveryOutputKeySchema,
    kind: z.enum(MaintenanceKind),
    /** The head the agent started from; it must be the target's current subject. */
    expectedRevision: revision,
    /** The resulting head and pull request base the agent published. */
    revision,
    pullRequestBase: z.string().min(1),
  })
  .strict();

export type DeliveryMaintenanceCommand = z.infer<typeof deliveryMaintenanceCommandSchema>;

/**
 * An immutable new subject for a selected change. The earlier subject, its reviews, checks and
 * QA stay historical; the PR keeps its original owner and the producer is the maintaining Run.
 */
export const deliveryMaintenanceSchema = z
  .object({
    maintenanceId: z.string().min(1),
    target: deliveryOutputKeySchema,
    kind: z.enum(MaintenanceKind),
    resourceId: z.string().min(1),
    repositoryResourceId: z.string().min(1),
    previous: subjectState,
    current: subjectState.extend({ baseRevision: z.string().min(1).optional() }).strict(),
    producer: z.object({ runId: z.string().min(1), activationId: z.string().min(1) }).strict(),
  })
  .strict();

export type DeliveryMaintenance = z.infer<typeof deliveryMaintenanceSchema>;

/** A final delivery gate can be reassessed through ordinary operator retry. */
export interface DeliveryCompletionBlock {
  readonly reason: string;
  readonly deliveryGate: { readonly retryStage: StageName };
}

export class DeliveryRejectionError extends Error {
  constructor(
    readonly code: DeliveryRejection,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryRejectionError';
  }
}
