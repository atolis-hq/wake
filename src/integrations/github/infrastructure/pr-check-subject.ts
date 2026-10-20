import type { PullRequestCheckEvidence } from '../../../activities/index.js';
import type {
  GitHubCheckRunPayload,
  GitHubPullRequestPayload,
  GitHubWorkflowRunPayload,
} from '../contracts/payloads.js';
import { GitHubCheckRunStatus } from '../contracts/vocabulary.js';
import type { TestedCommit } from './check-execution.js';
import type { CheckEvidence, PullRequestEvidenceClient } from './pr-evidence.js';

/** Join head-SHA checks to their actual checkout, never mutable linked PR metadata. */
export async function verifiedCheckSubject(
  client: PullRequestEvidenceClient,
  owner: string,
  repo: string,
  pullRequest: GitHubPullRequestPayload,
  evidence: CheckEvidence,
): Promise<{ readonly checkEvidence?: PullRequestCheckEvidence }> {
  if (!eligibleEvidence(evidence, client)) return {};
  try {
    const suites = new Map<number, readonly GitHubWorkflowRunPayload[]>();
    const testedRevisions: string[] = [];
    for (const check of evidence.checkRuns) {
      if (!qualifyingCheck(check, pullRequest.head?.sha)) return {};
      const suiteId = check.check_suite!.id;
      if (!suites.has(suiteId))
        suites.set(suiteId, await client.workflowRunsForSuite!(owner, repo, suiteId));
      const matching = suites
        .get(suiteId)!
        .filter((run) => matchesExecution(run, suiteId, pullRequest));
      if (matching.length !== 1) return {};
      if (check.conclusion !== 'success') continue;
      const commit = await readCheckout(client.checkExecution!, owner, repo, matching[0]!, check);
      if (!matchesCheckout(commit, pullRequest)) return {};
      testedRevisions.push(commit!.sha);
    }
    if (testedRevisions.length === 0) return {};
    return {
      checkEvidence: {
        testedRevision: testedRevisions[0]!,
        headRevision: pullRequest.head!.sha!,
        baseRevision: pullRequest.base!.sha!,
        startedAt: new Date(
          Math.min(...evidence.checkRuns.map((run) => Date.parse(run.started_at!))),
        ).toISOString(),
      },
    };
  } catch {
    return {};
  }
}

function eligibleEvidence(evidence: CheckEvidence, client: PullRequestEvidenceClient): boolean {
  return (
    client.workflowRunsForSuite !== undefined &&
    client.checkExecution !== undefined &&
    evidence.available &&
    evidence.complete &&
    evidence.statuses.length === 0 &&
    evidence.checkRuns.length > 0
  );
}

function qualifyingCheck(check: GitHubCheckRunPayload, head: string | undefined): boolean {
  return (
    head !== undefined &&
    check.head_sha === head &&
    check.check_suite != null &&
    check.status === GitHubCheckRunStatus.Completed &&
    passingConclusions.has(check.conclusion ?? '') &&
    typeof check.started_at === 'string' &&
    Number.isFinite(Date.parse(check.started_at))
  );
}

function matchesExecution(
  run: GitHubWorkflowRunPayload,
  suiteId: number,
  pr: GitHubPullRequestPayload,
): boolean {
  return (
    run.check_suite_id === suiteId &&
    run.event === 'pull_request' &&
    run.head_sha === pr.head?.sha &&
    run.status === GitHubCheckRunStatus.Completed &&
    run.conclusion === 'success'
  );
}

const passingConclusions = new Set(['success', 'neutral', 'skipped']);

function matchesCheckout(commit: TestedCommit | undefined, pr: GitHubPullRequestPayload): boolean {
  return (
    commit !== undefined &&
    commit.parents.length === 2 &&
    commit.parents[0]?.sha === pr.base?.sha &&
    commit.parents[1]?.sha === pr.head?.sha
  );
}

async function readCheckout(
  reader: NonNullable<PullRequestEvidenceClient['checkExecution']>,
  owner: string,
  repo: string,
  execution: GitHubWorkflowRunPayload,
  check: GitHubCheckRunPayload,
): Promise<TestedCommit | undefined> {
  if (check.id === undefined) return undefined;
  return reader(owner, repo, execution.id, execution.run_attempt ?? 1, check.id);
}
