import { z } from 'zod';
import { repositoryAssignmentSchema } from './repository-assignment.js';

/**
 * Selected pull requests an agent may maintain, chosen by Orchestration for one activation.
 * Each target is leased through the child's own recorded branch workspace; the PR keeps its
 * original owner and the maintaining Run is recorded as the actual producer.
 */
export const executionMaintenanceSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            childWorkItemId: z.string().min(1),
            outputName: z.string().min(1),
            resourceId: z.string().min(1),
            /** The repository assignment the child's workspace was created from. */
            repository: repositoryAssignmentSchema,
            branch: z.string().min(1),
            revision: z.string().min(1),
            pullRequestBase: z.string().min(1),
            /** Why integration cannot proceed yet, when it cannot. */
            reason: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ExecutionMaintenance = z.infer<typeof executionMaintenanceSchema>;

export const preparedMaintenanceSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            childWorkItemId: z.string().min(1),
            outputName: z.string().min(1),
            resourceId: z.string().min(1),
            branch: z.string().min(1),
            revision: z.string().min(1),
            path: z.string().min(1),
            reason: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type PreparedMaintenance = z.infer<typeof preparedMaintenanceSchema>;
