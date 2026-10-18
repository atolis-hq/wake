import { z } from 'zod';
import { activationId } from '../../activities/index.js';
import { artifactRevisionReferenceSchema } from '../../artifacts/index.js';
import { brandedStringSchema } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import { workflowInstanceId, workflowName } from './identifiers.js';

export const delegatedAssignmentSchema = z
  .object({
    assignmentId: z.string().min(1),
    objective: z.string().trim().min(1),
    criteria: z.array(z.string().trim().min(1)).min(1),
    workflowName: brandedStringSchema(workflowName),
    workflowFingerprint: z.string().min(1),
    context: z.array(artifactRevisionReferenceSchema),
    outputs: z
      .array(z.object({ name: z.string().min(1), path: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();

export type DelegatedAssignment = z.infer<typeof delegatedAssignmentSchema>;

export const delegationReservationSchema = z
  .object({
    cohortId: z.string().min(1),
    parentWorkflowInstanceId: brandedStringSchema(workflowInstanceId),
    parentWorkItemId: brandedStringSchema(workItemId),
    rootWorkItemId: brandedStringSchema(workItemId),
    activationId: brandedStringSchema(activationId),
    runId: z.string().min(1),
    ancestors: z.array(brandedStringSchema(workItemId)),
    maxDepth: z.number().int().positive(),
    maxDescendants: z.number().int().positive(),
    children: z
      .array(
        delegatedAssignmentSchema
          .extend({
            workItemId: brandedStringSchema(workItemId),
            workflowInstanceId: brandedStringSchema(workflowInstanceId),
            grantId: z.string().min(1),
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
        z.object({ name: z.string().min(1), reference: artifactRevisionReferenceSchema }).strict(),
      )
      .min(1),
  })
  .strict();

export type DelegationResult = z.infer<typeof delegationResultSchema>;

export const delegationWaitSchema = z
  .object({ cohortId: z.string().min(1), activationId: brandedStringSchema(activationId) })
  .strict();

export const delegationJoinSchema = z
  .object({ cohortId: z.string().min(1), results: z.array(delegationResultSchema).min(1) })
  .strict();

export interface DelegationLimits {
  readonly maxDepth: number;
  readonly maxDescendants: number;
}

/** Obtained from the active Run capability, never from an assignment payload. */
export interface DelegationCaller {
  readonly workflowInstanceId: ReturnType<typeof workflowInstanceId>;
  readonly activationId: ReturnType<typeof activationId>;
  readonly runId: string;
}
