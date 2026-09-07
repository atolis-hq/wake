import type { GitHubCheckRunPayload, GitHubCommitStatusPayload } from '../contracts/payloads.js';

export interface CheckEvidence {
  readonly available: boolean;
  readonly complete: boolean;
  readonly checkRuns: readonly GitHubCheckRunPayload[];
  readonly statuses: readonly GitHubCommitStatusPayload[];
}

export interface ChangedFiles {
  readonly files: readonly string[] | undefined;
  readonly complete: boolean;
}

interface PullRequestEvidenceClient {
  listCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
    maxResults?: number,
  ): Promise<readonly GitHubCheckRunPayload[]>;
  getCombinedStatusForRef(
    owner: string,
    repo: string,
    ref: string,
    maxResults?: number,
  ): Promise<readonly GitHubCommitStatusPayload[]>;
  listPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    maxResults?: number,
  ): Promise<readonly string[]>;
}

export async function readPullRequestEvidence(
  client: PullRequestEvidenceClient,
  owner: string,
  repo: string,
  headRevision: string,
  pullNumber: number,
  maxResults: number,
): Promise<readonly [CheckEvidence, ChangedFiles]> {
  return Promise.all([
    readCheckEvidence(client, owner, repo, headRevision, maxResults),
    readChangedFiles(client, owner, repo, pullNumber, maxResults),
  ]);
}

async function readCheckEvidence(
  client: PullRequestEvidenceClient,
  owner: string,
  repo: string,
  headRevision: string,
  maxResults: number,
): Promise<CheckEvidence> {
  try {
    const [checkRuns, statuses] = await Promise.all([
      client.listCheckRunsForRef(owner, repo, headRevision, maxResults),
      client.getCombinedStatusForRef(owner, repo, headRevision, maxResults),
    ]);
    return {
      available: true,
      complete: checkRuns.length < maxResults && statuses.length < maxResults,
      checkRuns,
      statuses,
    };
  } catch {
    return { available: false, complete: false, checkRuns: [], statuses: [] };
  }
}

async function readChangedFiles(
  client: PullRequestEvidenceClient,
  owner: string,
  repo: string,
  pullNumber: number,
  maxResults: number,
): Promise<ChangedFiles> {
  try {
    const files = await client.listPullRequestFiles(owner, repo, pullNumber, maxResults);
    return { files, complete: files.length < maxResults };
  } catch {
    return { files: undefined, complete: false };
  }
}
