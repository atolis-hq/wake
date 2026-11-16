import { z } from 'zod';
import { reportedArtifactSchema } from '../../activities/index.js';
import type { RunView } from '../../execution/index.js';
import { BuiltInResourceKind } from '../../resources/index.js';

const reportsSchema = z.object({ reportedArtifacts: z.array(reportedArtifactSchema) });

/** Latest run's claim for a name; identical repeats collapse, conflicting repeats yield no claim. */
export function reportedChange(runs: readonly RunView[], name: string) {
  const claims = runs.flatMap((run) => {
    const data = reportsSchema.safeParse(run.outcome?.data);
    const reports = data.success
      ? data.data.reportedArtifacts.filter(
          (entry) => entry.name === name && entry.kind === BuiltInResourceKind.PullRequest,
        )
      : [];
    return reports.length === 0 ? [] : [{ run, reports }];
  });
  const latest = claims.at(-1);
  const report = latest?.reports[0];
  if (latest === undefined || report === undefined) return undefined;
  const conflicting = latest.reports.some(
    (entry) =>
      entry.externalKey.adapter !== report.externalKey.adapter ||
      entry.externalKey.key !== report.externalKey.key,
  );
  return conflicting ? undefined : { run: latest.run, report };
}
