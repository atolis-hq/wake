import type { PullRequestCheckEvidence } from '../../../activities/index.js';
import type { GitHubCheckRunPayload, GitHubPullRequestPayload } from '../contracts/payloads.js';
import { GitHubCheckRunStatus } from '../contracts/vocabulary.js';
import { readCheckEvidence, type PullRequestEvidenceClient } from './pr-evidence.js';

/** Only executions on a verified test-merge commit establish the tested base. */
export async function verifiedCheckSubject(
  client: PullRequestEvidenceClient,
  owner: string,
  repo: string,
  pullRequest: GitHubPullRequestPayload,
  maxResults: number,
): Promise<{ readonly checkEvidence?: PullRequestCheckEvidence }> {
  const revision = pullRequest.merge_commit_sha;
  if (!revision || !client.getCommit || pullRequest.merged_at) return {};
  try {
    const commit = await client.getCommit(owner, repo, revision);
    if (!matchesSubject(commit, revision, pullRequest)) return {};
    const evidence = await readCheckEvidence(client, owner, repo, revision, maxResults);
    if (!evidence.available || !evidence.complete || evidence.statuses.length > 0) return {};
    // Legacy commit statuses lack an execution head SHA. Never infer their provenance.
    const runs = evidence.checkRuns;
    if (runs.length === 0 || runs.some((run) => !qualifyingRun(run, revision))) return {};
    return {
      checkEvidence: {
        testedRevision: revision,
        headRevision: commit.parents[1]!.sha,
        baseRevision: commit.parents[0]!.sha,
        startedAt: new Date(
          Math.min(...runs.map((run) => Date.parse(run.started_at!))),
        ).toISOString(),
      },
    };
  } catch {
    return {};
  }
}

function qualifyingRun(run: GitHubCheckRunPayload, revision: string): boolean {
  return (
    run.head_sha === revision &&
    run.status === GitHubCheckRunStatus.Completed &&
    run.conclusion === 'success' &&
    typeof run.started_at === 'string' &&
    Number.isFinite(Date.parse(run.started_at))
  );
}

function matchesSubject(
  commit: { readonly sha: string; readonly parents: readonly { readonly sha: string }[] },
  revision: string,
  pullRequest: GitHubPullRequestPayload,
): boolean {
  return (
    commit.sha === revision &&
    commit.parents.length === 2 &&
    commit.parents[0]?.sha === pullRequest.base?.sha &&
    commit.parents[1]?.sha === pullRequest.head?.sha
  );
}
