import { z } from 'zod';
import { activationId } from '../../activities/index.js';
import { brandedStringSchema } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import { workflowInstanceId, workflowName } from './identifiers.js';
import {
  DelegationOutputKind,
  DelegationPrerequisiteCondition,
  type DelegationConflictCode,
} from './vocabulary.js';

export const delegationPrerequisiteSchema = z
  .object({
    cohortId: z.string().min(1).optional(),
    assignmentId: z.string().min(1),
    output: z.string().min(1),
    condition: z.enum(DelegationPrerequisiteCondition),
    useAsBase: z.boolean().optional(),
  })
  .strict();

export type DelegationPrerequisite = z.infer<typeof delegationPrerequisiteSchema>;

export const delegationRevisionReferenceSchema = z
  .object({
    workItemId: brandedStringSchema(workItemId),
    revisionId: z.string().min(1),
  })
  .strict();

export type DelegationRevisionReference = z.infer<typeof delegationRevisionReferenceSchema>;

export const repositoryAssignmentRequestSchema = z
  .object({
    resourceId: z.string().min(1),
    sourceRef: z.string().trim().min(1),
    sourceRevision: z
      .string()
      .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i)
      .optional(),
    pullRequestBase: z.string().trim().min(1),
  })
  .strict();

export type RepositoryAssignmentRequest = z.infer<typeof repositoryAssignmentRequestSchema>;

export const delegatedAssignmentSchema = z
  .object({
    assignmentId: z.string().min(1),
    objective: z.string().trim().min(1),
    criteria: z.array(z.string().trim().min(1)).min(1),
    workflowName: brandedStringSchema(workflowName),
    repositoryResourceIds: z.array(z.string().min(1)).optional(),
    workflowFingerprint: z.string().min(1),
    context: z.array(delegationRevisionReferenceSchema),
    repository: repositoryAssignmentRequestSchema.optional(),
    prerequisites: z.array(delegationPrerequisiteSchema).optional(),
    outputs: z
      .array(
        z.union([
          z.object({ name: z.string().min(1), path: z.string().min(1) }).strict(),
          z
            .object({
              name: z.string().min(1),
              kind: z.literal(DelegationOutputKind.Change),
              requireReview: z.boolean().optional(),
              requireChecks: z.boolean().optional(),
            })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict();

export const delegationSubmissionSchema = z
  .object({
    cohortId: z.string().min(1),
    expectedPlanRevision: z.number().int().nonnegative().optional(),
    assignments: z.array(delegatedAssignmentSchema.omit({ workflowFingerprint: true })).min(1),
  })
  .strict();

export type DelegationSubmission = z.infer<typeof delegationSubmissionSchema>;

export type DelegatedAssignment = z.infer<typeof delegatedAssignmentSchema>;

export const delegationReservationSchema = z
  .object({
    cohortId: z.string().min(1),
    planRevision: z.number().int().positive().optional(),
    parentWorkflowInstanceId: brandedStringSchema(workflowInstanceId),
    parentWorkItemId: brandedStringSchema(workItemId),
    rootWorkItemId: brandedStringSchema(workItemId),
    activationId: brandedStringSchema(activationId),
    runId: z.string().min(1),
    ancestors: z.array(brandedStringSchema(workItemId)),
    maxConcurrentRuns: z.number().int().positive().optional(),
    maxDepth: z.number().int().positive(),
    maxDescendants: z.number().int().positive(),
    children: z
      .array(
        delegatedAssignmentSchema
          .extend({
            repository: repositoryAssignmentRequestSchema
              .extend({
                sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
              })
              .strict()
              .optional(),
            workItemId: brandedStringSchema(workItemId),
            workflowInstanceId: brandedStringSchema(workflowInstanceId),
            grantId: z.string().min(1),
            prerequisiteWorkItemIds: z.array(brandedStringSchema(workItemId)).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type DelegationReservation = z.infer<typeof delegationReservationSchema>;

export const delegationResultSchema = z
  .object({
    cohortId: z.string().min(1),
    childWorkItemId: brandedStringSchema(workItemId),
    outputs: z
      .array(
        z
          .object({
            name: z.string().min(1),
            reference: z.union([
              delegationRevisionReferenceSchema,
              z
                .object({
                  workItemId: brandedStringSchema(workItemId),
                  resourceId: z.string().min(1),
                  repositoryResourceId: z.string().min(1),
                  revision: z.string().min(1),
                  branch: z.string().min(1),
                  pullRequestBase: z.string().min(1),
                  runId: z.string().min(1),
                  baseRevision: z.string().min(1).optional(),
                  merged: z.literal(true).optional(),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type DelegationResult = z.infer<typeof delegationResultSchema>;

export const delegationInputsSchema = z
  .object({
    childWorkItemId: brandedStringSchema(workItemId),
    consumed: z.array(delegationResultSchema.shape.outputs.element),
    repository: repositoryAssignmentRequestSchema
      .extend({
        sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DelegationInputs = z.infer<typeof delegationInputsSchema>;

export class DelegationConflictError extends Error {
  constructor(
    readonly code: DelegationConflictCode,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationConflictError';
  }
}

export const delegationWaitSchema = z
  .object({ cohortId: z.string().min(1), activationId: brandedStringSchema(activationId) })
  .strict();

export const delegationJoinSchema = z
  .object({ cohortId: z.string().min(1), results: z.array(delegationResultSchema).min(1) })
  .strict();

export interface DelegationLimits {
  readonly maxConcurrentRuns?: number;
  readonly maxDepth: number;
  readonly maxDescendants: number;
}

/** Obtained from the active Run capability, never from an assignment payload. */
export interface DelegationCaller {
  readonly workflowInstanceId: ReturnType<typeof workflowInstanceId>;
  readonly activationId: ReturnType<typeof activationId>;
  readonly runId: string;
}

/** Retryable rejection: callers retain their signal or execution evidence until the cohort settles. */
export class DelegationPendingError extends Error {
  constructor(id: string) {
    super(`Workflow ${id} has an outstanding delegation; retry after it settles`);
    this.name = 'DelegationPendingError';
  }
}
