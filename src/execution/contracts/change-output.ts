import { z } from 'zod';
import { repositoryAssignmentSchema } from './repository-assignment.js';

/** Recorded by Execution from leased workspaces, never supplied by a PR claim. */
export const changeOutputWorkspaceSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    branch: z.string().min(1),
    repository: repositoryAssignmentSchema,
    revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  })
  .strict();

export type ChangeOutputWorkspace = z.infer<typeof changeOutputWorkspaceSchema>;
