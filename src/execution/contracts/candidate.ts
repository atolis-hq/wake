import { z } from 'zod';
import { repositoryAssignmentSchema } from './repository-assignment.js';

/** Authorized, exact inputs selected by Orchestration for a QA activation. */
export const executionCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    selectionRevision: z.number().int().positive(),
    criteria: z.array(z.string()),
    inputs: z.array(
      z
        .object({
          workItemId: z.string().min(1),
          outputName: z.string().min(1),
          revision: z.string().min(1),
        })
        .strict(),
    ),
    recipe: z.string().optional(),
    repositories: z
      .array(
        repositoryAssignmentSchema
          .extend({
            requiredSourceRef: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ExecutionCandidate = z.infer<typeof executionCandidateSchema>;

export const preparedCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    selectionRevision: z.number().int().positive(),
    repositories: z
      .array(
        z
          .object({
            resourceId: z.string().min(1),
            revision: z.string().min(1),
            path: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type PreparedCandidate = z.infer<typeof preparedCandidateSchema>;
