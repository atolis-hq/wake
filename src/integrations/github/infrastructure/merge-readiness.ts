import type { Octokit } from '@octokit/rest';
import { PullRequestCheckState } from '../../../activities/index.js';
import { getCombinedStatusForRef, listCheckRunsForRef } from './client-reads.js';
import { createEtagCache } from './etag-cache.js';
import { normalizeCheckEvidence } from './pr-source.js';

/** GitHub also calls failing checks unstable; only transient readiness may wait. */
export async function hasFailingMergeChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  revision: string,
): Promise<boolean> {
  const cache = createEtagCache();
  const [runs, statuses] = await Promise.all([
    listCheckRunsForRef(octokit, cache, owner, repo, revision),
    getCombinedStatusForRef(octokit, cache, owner, repo, revision),
  ]);
  return normalizeCheckEvidence(runs, statuses) === PullRequestCheckState.Failing;
}
