import { z } from 'zod';

/** Provider execution evidence for one exact head/base combination. */
export const pullRequestCheckEvidenceSchema = z
  .object({
    testedRevision: z.string().min(1).optional(),
    headRevision: z.string().min(1),
    baseRevision: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type PullRequestCheckEvidence = z.infer<typeof pullRequestCheckEvidenceSchema>;

export function sameCheckEvidence(
  a: PullRequestCheckEvidence | undefined,
  b: PullRequestCheckEvidence | undefined,
): boolean {
  return (
    a?.testedRevision === b?.testedRevision &&
    a?.headRevision === b?.headRevision &&
    a?.baseRevision === b?.baseRevision &&
    a?.startedAt === b?.startedAt
  );
}
