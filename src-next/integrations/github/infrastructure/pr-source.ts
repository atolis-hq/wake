import {
  PullRequestCheckState,
  PullRequestState,
  ReviewActorKind,
  type PullRequestCheckState as PullRequestCheckStateValue,
} from '../../../activities/index.js';
import { EventSourceKind } from '../../../kernel/index.js';
import { createHash } from 'node:crypto';
import { createEventDraft, EventActorKind } from '../../../kernel/index.js';
import { GitHubAdapter } from '../contracts/vocabulary.js';
import { integrationStream } from '../../contracts/streams.js';
import { formatGitHubResourceKey } from '../contracts/external-key.js';
import type { ExternalEventSource } from '../application/poll-service.js';
import type {
  GitHubCheckRunPayload,
  GitHubCommitStatusPayload,
  GitHubPullRequestPayload,
} from '../contracts/payloads.js';
import { GitHubEventType, type GitHubAdapterEventDraft } from '../contracts/events.js';
import {
  GitHubCheckRunStatus,
  UnknownGitHubIdentity,
  UnknownGitHubRevision,
} from '../contracts/vocabulary.js';

interface CheckEvidence {
  readonly available: boolean;
  readonly checkRuns: readonly GitHubCheckRunPayload[];
  readonly statuses: readonly GitHubCommitStatusPayload[];
}

export interface GitHubPullRequestSourceClient {
  listPullRequests(
    owner: string,
    repo: string,
    maxResults: number,
  ): Promise<readonly GitHubPullRequestPayload[]>;
  listCheckRunsForRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<readonly GitHubCheckRunPayload[]>;
  getCombinedStatusForRef(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<readonly GitHubCommitStatusPayload[]>;
}

export function createGitHubPullRequestSource(input: {
  readonly client: GitHubPullRequestSourceClient;
  readonly repository: string;
  readonly maxResults: number;
  readonly maxConcurrency?: number;
}): ExternalEventSource {
  const { owner, repo } = parseRepository(input.repository);
  return {
    async poll(signal) {
      signal.throwIfAborted();
      const pullRequests = await input.client.listPullRequests(owner, repo, input.maxResults);
      return mapConcurrent(pullRequests, input.maxConcurrency ?? 4, async (pullRequest) => {
        signal.throwIfAborted();
        const headRevision = fallback(pullRequest.head?.sha, pullRequest.updated_at);
        const evidence = await readCheckEvidence(input.client, owner, repo, headRevision);
        return pullRequestObservation({ repository: input.repository, pullRequest, evidence });
      });
    },
  };
}

function pullRequestObservation(input: {
  readonly repository: string;
  readonly pullRequest: GitHubPullRequestPayload;
  readonly evidence: CheckEvidence;
}): Extract<GitHubAdapterEventDraft, { eventType: typeof GitHubEventType.WorkObserved }> {
  const pullRequest = input.pullRequest;
  const key = formatGitHubResourceKey({
    ...parseRepository(input.repository),
    number: pullRequest.number,
  });
  const revision = fallback(pullRequest.head?.sha, pullRequest.updated_at);
  const checks = input.evidence.available
    ? normalizeCheckEvidence(input.evidence.checkRuns, input.evidence.statuses)
    : PullRequestCheckState.Unknown;
  const payload = {
    externalKey: key,
    kind: 'pull-request' as const,
    title: pullRequest.title,
    body: fallback(pullRequest.body, ''),
    state: pullRequestState(pullRequest),
    revision,
    headRevision: revision,
    baseRevision: fallback(pullRequest.base?.sha, UnknownGitHubRevision),
    checks,
    actor: {
      id: fallback(pullRequest.user?.login, UnknownGitHubIdentity),
      kind: actorKind(pullRequest.user?.type),
    },
    raw: { number: pullRequest.number },
  };
  const fingerprint = evidenceFingerprint(payload, input.evidence);
  return createEventDraft({
    eventId: `github:pr:${key}:${fingerprint}`,
    eventType: GitHubEventType.WorkObserved,
    occurredAt: pullRequest.updated_at,
    correlationId: `github:${key}`,
    causationId: `github:${key}:${fingerprint}`,
    actor: { kind: EventActorKind.Integration, id: 'github' },
    source: { kind: EventSourceKind.Adapter, id: 'github' },
    stream: integrationStream(GitHubAdapter),
    payload,
  });
}

function normalizeCheckEvidence(
  checkRuns: readonly GitHubCheckRunPayload[],
  statuses: readonly GitHubCommitStatusPayload[],
): PullRequestCheckStateValue {
  const states = [
    ...checkRuns.map(checkRunState),
    ...statuses.map((status) => commitStatusState(status.state)),
  ];
  if (states.includes(PullRequestCheckState.Failing)) return PullRequestCheckState.Failing;
  if (states.includes(PullRequestCheckState.Pending)) return PullRequestCheckState.Pending;
  if (states.includes(PullRequestCheckState.Passing)) return PullRequestCheckState.Passing;
  return PullRequestCheckState.Unknown;
}

async function readCheckEvidence(
  client: GitHubPullRequestSourceClient,
  owner: string,
  repo: string,
  headRevision: string,
): Promise<CheckEvidence> {
  try {
    const [checkRuns, statuses] = await Promise.all([
      client.listCheckRunsForRef(owner, repo, headRevision),
      client.getCombinedStatusForRef(owner, repo, headRevision),
    ]);
    return { available: true, checkRuns, statuses };
  } catch {
    return { available: false, checkRuns: [], statuses: [] };
  }
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  transform: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await transform(values[index]!);
    }
  }
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return output;
}

function evidenceFingerprint(payload: object, evidence: CheckEvidence): string {
  const providerEvidence = {
    available: evidence.available,
    checkRuns: evidence.checkRuns.map(checkRunIdentity).sort(compareJson),
    statuses: evidence.statuses.map(statusIdentity).sort(compareJson),
  };
  return createHash('sha256').update(JSON.stringify({ payload, providerEvidence })).digest('hex');
}

function checkRunIdentity(checkRun: GitHubCheckRunPayload) {
  return {
    id: checkRun.id ?? null,
    name: checkRun.name ?? null,
    status: checkRun.status ?? null,
    conclusion: checkRun.conclusion ?? null,
    startedAt: checkRun.started_at ?? null,
    completedAt: checkRun.completed_at ?? null,
  };
}

function statusIdentity(status: GitHubCommitStatusPayload) {
  return {
    id: status.id ?? null,
    context: status.context ?? null,
    state: status.state ?? null,
    createdAt: status.created_at ?? null,
    updatedAt: status.updated_at ?? null,
  };
}

function compareJson(left: object, right: object): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function checkRunState(checkRun: GitHubCheckRunPayload): PullRequestCheckStateValue {
  if (checkRun.status !== GitHubCheckRunStatus.Completed) return PullRequestCheckState.Pending;
  if (checkRun.conclusion === null || checkRun.conclusion === undefined)
    return PullRequestCheckState.Pending;
  return passingConclusions.has(checkRun.conclusion)
    ? PullRequestCheckState.Passing
    : PullRequestCheckState.Failing;
}

function commitStatusState(state: string | undefined): PullRequestCheckStateValue {
  if (state === GitHubCommitStatusState.Failure || state === GitHubCommitStatusState.Error)
    return PullRequestCheckState.Failing;
  if (state === GitHubCommitStatusState.Pending) return PullRequestCheckState.Pending;
  return state === GitHubCommitStatusState.Success
    ? PullRequestCheckState.Passing
    : PullRequestCheckState.Unknown;
}

function pullRequestState(
  pullRequest: GitHubPullRequestPayload,
): typeof PullRequestState.Open | typeof PullRequestState.Closed | typeof PullRequestState.Merged {
  if (pullRequest.merged_at !== null && pullRequest.merged_at !== undefined)
    return PullRequestState.Merged;
  return pullRequest.state;
}

function parseRepository(repository: string): { readonly owner: string; readonly repo: string } {
  const [owner, repo, ...extra] = repository.split('/');
  if (owner === undefined || repo === undefined || extra.length > 0)
    throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, repo };
}

function fallback<Value>(value: Value | null | undefined, defaultValue: Value): Value {
  return value === null || value === undefined ? defaultValue : value;
}

function actorKind(
  type: string | undefined,
): typeof ReviewActorKind.Bot | typeof ReviewActorKind.Human {
  return type === 'Bot' ? ReviewActorKind.Bot : ReviewActorKind.Human;
}

const passingConclusions = new Set(['success', 'neutral', 'skipped']);
const GitHubCommitStatusState = {
  Error: 'error',
  Failure: 'failure',
  Pending: PullRequestCheckState.Pending,
  Success: 'success',
} as const;
