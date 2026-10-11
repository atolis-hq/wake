import { z } from 'zod';
import { ActivityOutcomeKind } from '../contracts/vocabulary.js';
import { PullRequestDenialCode } from './vocabulary.js';

export const mergePolicyDetailsSchema = z
  .object({
    blockedPaths: z.array(z.string()).optional(),
    matchedPaths: z.array(z.string()).optional(),
    maxFilesChanged: z.number().int().positive().optional(),
    filesChanged: z.number().int().nonnegative().optional(),
  })
  .strict();

export type MergePolicyDetails = z.infer<typeof mergePolicyDetailsSchema>;

const denialSchema = z
  .object({
    kind: z.literal(ActivityOutcomeKind.Blocked),
    data: z
      .object({
        reason: z.enum([
          PullRequestDenialCode.BlockedPathChanged,
          PullRequestDenialCode.TooManyFilesChanged,
          PullRequestDenialCode.ChangedFilesUnavailable,
        ]),
        resourceId: z.string().optional(),
        revision: z.string().optional(),
        policy: mergePolicyDetailsSchema.optional(),
      })
      .strict(),
  })
  .strict();

export function readMergePolicyDenial(outcome: unknown) {
  const parsed = denialSchema.safeParse(outcome);
  return parsed.success ? parsed.data.data : null;
}
