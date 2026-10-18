import { z } from 'zod';

export const repositoryAssignmentSchema = z
  .object({
    resourceId: z.string().min(1),
    sourceRef: z.string().min(1),
    sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    pullRequestBase: z.string().min(1),
  })
  .strict();

/** Durable source and logical delivery base are independent Git identities. */
export interface RepositoryAssignment {
  readonly resourceId: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly pullRequestBase: string;
}

export type RepositoryAssignmentRequest = Omit<RepositoryAssignment, 'sourceRevision'> & {
  readonly sourceRevision?: string | undefined;
};
