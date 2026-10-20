import {
  pullRequestCheckEvidenceSchema,
  type PullRequestCheckEvidence,
} from '../../../activities/index.js';
import type { CheckEvidence } from './pr-evidence.js';

/** Old head checks keep their original start times even when the provider base has moved. */
export function verifiedCheckSubject(
  evidence: CheckEvidence,
  headRevision: string,
  baseRevision: string | undefined,
): { readonly checkEvidence?: PullRequestCheckEvidence } {
  if (!evidence.available || !evidence.complete || baseRevision === undefined) return {};
  const times = [
    ...evidence.checkRuns.map((run) => run.started_at),
    ...evidence.statuses.map((status) => status.created_at),
  ];
  if (
    times.length === 0 ||
    times.some((time) => typeof time !== 'string' || !Number.isFinite(Date.parse(time)))
  )
    return {};
  const startedAt = new Date(Math.min(...times.map((time) => Date.parse(time!)))).toISOString();
  const parsed = pullRequestCheckEvidenceSchema.safeParse({
    headRevision,
    baseRevision,
    startedAt,
  });
  return parsed.success ? { checkEvidence: parsed.data } : {};
}
