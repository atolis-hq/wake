import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResourceIndex } from '../../core/contracts.js';
import { buildResourceUri } from '../../domain/resource-uri.js';
import { isTerminalStage } from '../../domain/stages.js';
import { workflowForProjection } from '../../domain/workflows.js';
import type { EventEnvelope, IssueStateRecord, RunRecord, WakeConfig } from '../../domain/types.js';
import type { createStateStore } from '../fs/state-store.js';

type StateStore = ReturnType<typeof createStateStore>;

export type BoardCondition = 'needs-human' | 'active' | 'ready' | 'error' | 'finished';

interface LockMetadata {
  pid: number;
  acquiredAt: string;
}

function parseLockMetadata(raw: string): LockMetadata | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.pid !== 'number' || typeof parsed.acquiredAt !== 'string') {
      return null;
    }
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readLockInfo(
  lockFile: string,
  now: Date,
): Promise<{
  present: boolean;
  pid?: number;
  acquiredAt?: string;
  ageMs?: number;
  pidAlive?: boolean;
}> {
  try {
    const metadata = parseLockMetadata(await readFile(lockFile, 'utf8'));
    if (metadata === null) {
      return { present: true };
    }
    return {
      present: true,
      pid: metadata.pid,
      acquiredAt: metadata.acquiredAt,
      ageMs: now.getTime() - Date.parse(metadata.acquiredAt),
      pidAlive: isPidAlive(metadata.pid),
    };
  } catch {
    return { present: false };
  }
}

/**
 * Reproduces the sentinel-driven part of policy eligibility for display purposes only.
 * It never decides anything the tick doesn't independently decide — this is a read model.
 */
function deriveCondition(
  item: IssueStateRecord,
  lastRun: RunRecord | null,
  config: WakeConfig,
): { condition: BoardCondition; reason: string } {
  const stage = item.wake.stage;

  if (isTerminalStage(stage) || item.issue.state === 'closed') {
    return { condition: 'finished', reason: 'terminal stage' };
  }

  if (lastRun?.status === 'running') {
    return { condition: 'active', reason: 'run in flight' };
  }

  if (
    lastRun?.status === 'blocked' ||
    lastRun?.status === 'awaiting-approval' ||
    lastRun?.sentinel === 'BLOCKED' ||
    lastRun?.sentinel === 'AWAITING_APPROVAL'
  ) {
    return { condition: 'needs-human', reason: `sentinel ${lastRun?.sentinel ?? stage}` };
  }

  const workflow = workflowForProjection(item, config);
  const hasRoute = config.stages[stage] !== undefined || workflow?.stages[stage] !== undefined;
  if (!hasRoute) {
    return { condition: 'error', reason: `no route configured for stage "${stage}"` };
  }

  if (lastRun?.sentinel === 'FAILED') {
    return { condition: 'error', reason: 'last run failed; awaiting operator/retry policy' };
  }

  return { condition: 'ready', reason: 'has a route and no blocking condition' };
}

function timeInStageMs(item: IssueStateRecord, now: Date): number {
  const lastChange = item.wake.stageHistory.at(-1)?.changedAt ?? item.wake.syncedAt;
  return now.getTime() - Date.parse(lastChange);
}

export async function buildBoard(input: { stateStore: StateStore; config: WakeConfig; now: Date }) {
  const items = await input.stateStore.listIssueStates({
    archiveFreshnessDays: input.config.ui.archiveFreshnessDays,
    now: input.now,
  });
  const lastRuns = await Promise.all(
    items.map((item) =>
      item.wake.lastRunId === undefined
        ? Promise.resolve(null)
        : input.stateStore.readRunRecord(item.wake.lastRunId),
    ),
  );

  return items.map((item, index) => {
    const lastRun = lastRuns[index] ?? null;
    const { condition, reason } = deriveCondition(item, lastRun, input.config);

    return {
      repo: item.issue.repo,
      number: item.issue.number,
      title: item.issue.title,
      url: item.issue.url,
      stage: item.wake.stage,
      condition,
      conditionReason: reason,
      timeInStageMs: timeInStageMs(item, input.now),
      lastRunAction: lastRun?.action,
      lastRunSentinel: lastRun?.sentinel,
      lastRunStatus: lastRun?.status,
      sessionId: item.wake.sessionId,
      workspacePath: item.wake.workspacePath,
    };
  });
}

export async function buildStatus(input: {
  stateStore: StateStore;
  config: WakeConfig;
  now: Date;
}) {
  const today = input.now.toISOString().slice(0, 10);
  const [ledger, paused, recentEvents, todaysRuns, recentRuns, board] = await Promise.all([
    input.stateStore.readLedger(),
    input.stateStore.isPaused(),
    input.stateStore.listRecentEventEnvelopes({ limit: 1 }),
    input.stateStore.listRunRecordsForDate(today),
    input.stateStore.listRecentRunRecords(1),
    buildBoard(input),
  ]);

  const [tickLock, runnerLock] = await Promise.all([
    readLockInfo(input.stateStore.paths.tickLockFile, input.now),
    readLockInfo(input.stateStore.paths.runnerLockFile, input.now),
  ]);
  const tickLockLive = tickLock.present && tickLock.pidAlive === true;
  const runnerLockLive = runnerLock.present && runnerLock.pidAlive === true;

  // A quota-paused runner (#67) no longer stops the loop - routing falls
  // sideways to another candidate in the tier, so only the manual pause file
  // is a hard stop here. Per-runner health is surfaced separately below.
  //
  // Intake (tick.lock) and agent execution (runner.lock) are separate locks -
  // an in-flight agent run holds only runner.lock, so both must be checked or
  // the pill reads "idle" for the entire duration of a run.
  const loopState: 'paused' | 'working' | 'polling' | 'idle' = paused
    ? 'paused'
    : runnerLockLive
      ? 'working'
      : tickLockLive
        ? 'polling'
        : 'idle';
  const runnerHealth = ledger?.runners ?? {};

  const lastEvent = recentEvents[0];
  const lastRun = recentRuns[0];

  const counters: Record<BoardCondition, number> = {
    'needs-human': 0,
    active: 0,
    ready: 0,
    error: 0,
    finished: 0,
  };
  for (const card of board) {
    counters[card.condition] += 1;
  }

  const intervalMs = input.config.scheduler.intervalMs;
  const sourceStates = await listSourceStates(input.stateStore.paths.sourceStateRoot);
  const worstAgeMs =
    sourceStates.length === 0
      ? undefined
      : Math.max(
          ...sourceStates.map(
            (source) => input.now.getTime() - Date.parse(source.lastSuccessfulPollAt),
          ),
        );

  const sourceFreshness =
    worstAgeMs === undefined
      ? { level: 'unknown' as const }
      : {
          ageMs: worstAgeMs,
          level:
            worstAgeMs > intervalMs * 10
              ? ('red' as const)
              : worstAgeMs > intervalMs * 3
                ? ('amber' as const)
                : ('ok' as const),
        };

  return {
    loopState,
    paused,
    runnerHealth,
    lock: tickLock,
    runnerLock,
    lastEvent:
      lastEvent === undefined
        ? undefined
        : {
            at: lastEvent.ingestedAt,
            type: lastEvent.sourceEventType,
            workItemKey: lastEvent.workItemKey,
          },
    lastRun:
      lastRun === undefined
        ? undefined
        : {
            repo: lastRun.repo,
            issueNumber: lastRun.issueNumber,
            action: lastRun.action,
            sentinel: lastRun.sentinel,
            status: lastRun.status,
          },
    sourceFreshness,
    counters,
    runsToday: countToday(
      todaysRuns.map((run) => run.startedAt),
      input.now,
    ),
    failuresToday: countToday(
      todaysRuns.filter((run) => run.status === 'failed').map((run) => run.startedAt),
      input.now,
    ),
    costUsdToday: sumToday(
      todaysRuns.map((run) => ({ at: run.startedAt, value: run.tokenUsage?.costUsd ?? 0 })),
      input.now,
    ),
  };
}

function countToday(timestamps: string[], now: Date): number {
  const today = now.toISOString().slice(0, 10);
  return timestamps.filter((ts) => ts.slice(0, 10) === today).length;
}

function sumToday(entries: Array<{ at: string; value: number }>, now: Date): number {
  const today = now.toISOString().slice(0, 10);
  return entries
    .filter((entry) => entry.at.slice(0, 10) === today)
    .reduce((total, entry) => total + entry.value, 0);
}

async function listSourceStates(sourceStateRoot: string) {
  try {
    const sourceDirs = await readdir(sourceStateRoot);
    const results: { source: string; key: string; lastSuccessfulPollAt: string }[] = [];
    for (const sourceDir of sourceDirs) {
      const files = await readdir(join(sourceStateRoot, sourceDir)).catch(() => []);
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        try {
          const raw = JSON.parse(
            await readFile(join(sourceStateRoot, sourceDir, file), 'utf8'),
          ) as Record<string, unknown>;
          if (typeof raw.lastSuccessfulPollAt === 'string') {
            results.push({
              source: sourceDir,
              key: file.replace(/\.json$/, ''),
              lastSuccessfulPollAt: raw.lastSuccessfulPollAt,
            });
          }
        } catch {
          continue;
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function buildItemDetail(input: {
  stateStore: StateStore;
  resourceIndex: ResourceIndex;
  /** The active ticket source's registered name — the uri's provider segment. */
  provider: string;
  repo: string;
  issueNumber: number;
}) {
  // The UI addresses items by the ticket a human recognizes them by; work ids
  // are opaque (spec D3). The ticket's uri is *constructed* here (never parsed)
  // and resolved through the reverse index in one shard read (spec D2), then
  // everything downstream keys off the record's own workItemKey.
  const uri = buildResourceUri(input.provider, 'issue', `${input.repo}#${input.issueNumber}`);
  const workItemKey = await input.resourceIndex.resolve(uri);
  if (workItemKey === undefined) {
    return null;
  }

  const item = await input.stateStore.readIssueState(workItemKey);
  if (item === null) {
    return null;
  }

  const allRuns = await input.stateStore.listRunRecords();
  const runs = allRuns
    .filter((run) => run.workItemKey === item.workItemKey)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  const events = await input.stateStore.listEventEnvelopesForWorkItem(item.workItemKey, 50);

  return { item, runs, events };
}

export type ItemTranscriptEntry = {
  runId: string;
  action: string;
  cli: string;
  role: 'user' | 'agent';
  startedAt: string;
  text: string;
};

export type ItemTranscripts = {
  enabled: boolean;
  sessions: Array<{ sessionKey: string; sessionId?: string; entries: ItemTranscriptEntry[] }>;
};

function parseTranscriptFileName(file: string): {
  runId: string;
  cli: string;
  action: string;
  kind: 'prompt' | 'response';
  role: 'user' | 'agent';
} | null {
  if (!file.endsWith('.txt')) {
    return null;
  }
  const parts = file.slice(0, -'.txt'.length).split('.');
  if (parts.length < 4) {
    return null;
  }

  const kind = parts.at(-1);
  if (kind !== 'prompt' && kind !== 'response') {
    return null;
  }
  const action = parts.at(-2);
  const cli = parts.at(-3);
  const runId = parts.slice(0, -3).join('.');
  if (action === undefined || cli === undefined || runId.length === 0) {
    return null;
  }

  return {
    runId,
    cli,
    action,
    kind,
    role: kind === 'prompt' ? 'user' : 'agent',
  };
}

export async function buildItemTranscripts(input: {
  stateStore: StateStore;
  config: WakeConfig;
  workItemKey: string;
}): Promise<ItemTranscripts> {
  if (!input.config.transcripts.enabled) {
    return { enabled: false, sessions: [] };
  }

  const runs = (await input.stateStore.listRunRecords()).filter(
    (run) => run.workItemKey === input.workItemKey,
  );
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const workDir = input.stateStore.paths.transcriptWorkDir(input.workItemKey);
  const sessionDirs = (await readdir(workDir, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const sessionsByKey = new Map<
    string,
    { sessionKey: string; sessionId?: string; entries: ItemTranscriptEntry[] }
  >();
  for (const sessionKey of sessionDirs) {
    const sessionDir = join(workDir, sessionKey);
    const files = (await readdir(sessionDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    for (const file of files) {
      const parsed = parseTranscriptFileName(file);
      if (parsed === null) {
        continue;
      }
      const run = runsById.get(parsed.runId);
      if (run === undefined) {
        continue;
      }
      const transcriptEntry = {
        runId: parsed.runId,
        action: parsed.action,
        cli: parsed.cli,
        role: parsed.role,
        startedAt: run.startedAt,
        text: await readFile(join(sessionDir, file), 'utf8'),
      };
      const canonicalSessionKey = run.sessionId ?? sessionKey;
      const existing = sessionsByKey.get(canonicalSessionKey);
      if (existing === undefined) {
        sessionsByKey.set(canonicalSessionKey, {
          sessionKey: canonicalSessionKey,
          ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
          entries: [transcriptEntry],
        });
      } else {
        existing.entries.push(transcriptEntry);
      }
    }
  }

  const sessions = [...sessionsByKey.values()];
  for (const session of sessions) {
    session.entries.sort((left, right) => {
      const timeOrder = left.startedAt.localeCompare(right.startedAt);
      if (timeOrder !== 0) {
        return timeOrder;
      }
      if (left.runId !== right.runId) {
        return left.runId.localeCompare(right.runId);
      }
      const roleRank = { user: 0, agent: 1 };
      return roleRank[left.role] - roleRank[right.role];
    });
  }

  sessions.sort((left, right) => {
    const leftStartedAt = left.entries[0]?.startedAt ?? '';
    const rightStartedAt = right.entries[0]?.startedAt ?? '';
    const timeOrder = leftStartedAt.localeCompare(rightStartedAt);
    return timeOrder === 0 ? left.sessionKey.localeCompare(right.sessionKey) : timeOrder;
  });

  return { enabled: true, sessions };
}

export async function buildEventsFeed(input: {
  stateStore: StateStore;
  limit?: number | undefined;
  workItemKey?: string | undefined;
  direction?: EventEnvelope['direction'] | undefined;
  type?: string | undefined;
}) {
  const limit = input.limit ?? 200;
  return input.stateStore.listRecentEventEnvelopes({
    limit,
    ...(input.workItemKey === undefined ? {} : { workItemKey: input.workItemKey }),
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.type === undefined ? {} : { type: input.type }),
  });
}

export async function buildRuns(input: {
  stateStore: StateStore;
  status?: string | undefined;
  action?: string | undefined;
  repo?: string | undefined;
}) {
  const runs = await input.stateStore.listRunRecords();
  return runs
    .filter((run) => input.status === undefined || run.status === input.status)
    .filter((run) => input.action === undefined || run.action === input.action)
    .filter((run) => input.repo === undefined || run.repo === input.repo)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export type MetricsWindow = '1d' | '3d' | '5d' | '7d';
export type MetricsMetric =
  | 'runs-over-time'
  | 'runs-by-status-over-time'
  | 'runs-by-status'
  | 'runs-by-action'
  | 'runs-by-repo'
  | 'runs-by-runner'
  | 'runs-by-model'
  | 'runs-by-tier'
  | 'tokens-over-time'
  | 'tokens-by-action'
  | 'tokens-by-runner'
  | 'tokens-by-model'
  | 'duration-by-action'
  | 'duration-over-time'
  | 'work-items-over-time'
  | 'work-item-durations';

type MetricsSummary = {
  totalRuns: number;
  completedRuns: number;
  blockedRuns: number;
  awaitingApprovalRuns: number;
  failedRuns: number;
  totalTokens: number;
  totalCostUsd: number;
  medianRunDurationMs?: number | undefined;
  completedWorkItems: number;
  medianWorkItemDurationMs?: number | undefined;
};

type TimeBucket = { bucket: string; label: string; startMs: number; endMs: number };

const metricsWindows = new Set<MetricsWindow>(['1d', '3d', '5d', '7d']);
const metricsMetrics = new Set<MetricsMetric>([
  'runs-over-time',
  'runs-by-status-over-time',
  'runs-by-status',
  'runs-by-action',
  'runs-by-repo',
  'runs-by-runner',
  'runs-by-model',
  'runs-by-tier',
  'tokens-over-time',
  'tokens-by-action',
  'tokens-by-runner',
  'tokens-by-model',
  'duration-by-action',
  'duration-over-time',
  'work-items-over-time',
  'work-item-durations',
]);

function parseMetricsWindow(value: string | undefined): MetricsWindow {
  return metricsWindows.has(value as MetricsWindow) ? (value as MetricsWindow) : '7d';
}

function parseMetricsMetric(value: string | undefined): MetricsMetric {
  return metricsMetrics.has(value as MetricsMetric) ? (value as MetricsMetric) : 'runs-over-time';
}

function utcDayStartMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function monthDayLabel(date: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function createTimeBuckets(window: MetricsWindow, now: Date): TimeBucket[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  const todayStart = utcDayStartMs(now);

  if (window === '1d') {
    return Array.from({ length: 24 }, (_, hour) => {
      const startMs = todayStart + hour * hourMs;
      const day = new Date(startMs);
      return {
        bucket: `${day.toISOString().slice(0, 10)}T${pad2(hour)}`,
        label: `${pad2(hour)}:00`,
        startMs,
        endMs: startMs + hourMs,
      };
    });
  }

  if (window === '3d') {
    const start = todayStart - 2 * dayMs;
    return Array.from({ length: 12 }, (_, index) => {
      const startMs = start + index * 6 * hourMs;
      const day = new Date(startMs);
      const hour = day.getUTCHours();
      return {
        bucket: `${day.toISOString().slice(0, 10)}T${pad2(hour)}`,
        label: `${monthDayLabel(day)} ${pad2(hour)}:00`,
        startMs,
        endMs: startMs + 6 * hourMs,
      };
    });
  }

  const days = window === '5d' ? 5 : 7;
  const start = todayStart - (days - 1) * dayMs;
  return Array.from({ length: days }, (_, index) => {
    const startMs = start + index * dayMs;
    const day = new Date(startMs);
    return {
      bucket: day.toISOString().slice(0, 10),
      label: monthDayLabel(day),
      startMs,
      endMs: startMs + dayMs,
    };
  });
}

function inMetricsWindow(timestamp: string, buckets: TimeBucket[]): boolean {
  const at = Date.parse(timestamp);
  const first = buckets[0];
  const last = buckets.at(-1);
  return (
    Number.isFinite(at) &&
    first !== undefined &&
    last !== undefined &&
    at >= first.startMs &&
    at < last.endMs
  );
}

function findBucket(timestamp: string, buckets: TimeBucket[]): TimeBucket | undefined {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return buckets.find((bucket) => at >= bucket.startMs && at < bucket.endMs);
}

async function listRunsForBuckets(
  stateStore: StateStore,
  buckets: TimeBucket[],
): Promise<RunRecord[]> {
  const dates = [...new Set(buckets.map((bucket) => bucket.bucket.slice(0, 10)))];
  const runsById = new Map<string, RunRecord>();
  const recordsByDate = await Promise.all(
    dates.map((date) => stateStore.listRunRecordsForDate(date)),
  );
  for (const records of recordsByDate) {
    for (const record of records) {
      runsById.set(record.runId, record);
    }
  }
  return [...runsById.values()].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}

function runTokenTotal(run: RunRecord): number {
  const usage = run.tokenUsage;
  if (usage === undefined) {
    return 0;
  }
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheCreationInputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0)
  );
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function runDurationMs(run: RunRecord): number | undefined {
  if (run.finishedAt === undefined) {
    return undefined;
  }
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return undefined;
  }
  return finished - started;
}

function groupCount<T>(
  entries: T[],
  keyFor: (entry: T) => string,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = keyFor(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function groupTokens(
  runs: RunRecord[],
  keyFor: (run: RunRecord) => string,
): Array<{
  key: string;
  count: number;
  tokens: number;
  averageTokens: number;
  costUsd: number;
  averageCostUsd: number;
}> {
  const groups = new Map<string, { count: number; tokens: number; costUsd: number }>();
  for (const run of runs) {
    const key = keyFor(run);
    const existing = groups.get(key) ?? { count: 0, tokens: 0, costUsd: 0 };
    existing.count += 1;
    existing.tokens += runTokenTotal(run);
    existing.costUsd += run.tokenUsage?.costUsd ?? 0;
    groups.set(key, existing);
  }
  return [...groups.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
      averageTokens: value.count === 0 ? 0 : value.tokens / value.count,
      averageCostUsd: value.count === 0 ? 0 : value.costUsd / value.count,
    }))
    .sort((left, right) => right.tokens - left.tokens || left.key.localeCompare(right.key));
}

function groupDurations(
  runs: RunRecord[],
  keyFor: (run: RunRecord) => string,
): Array<{ key: string; count: number; totalMs: number; averageMs: number; medianMs: number }> {
  const groups = new Map<string, number[]>();
  for (const run of runs) {
    const duration = runDurationMs(run);
    if (duration === undefined) {
      continue;
    }
    const key = keyFor(run);
    groups.set(key, [...(groups.get(key) ?? []), duration]);
  }
  return [...groups.entries()]
    .map(([key, values]) => ({
      key,
      count: values.length,
      totalMs: values.reduce((total, value) => total + value, 0),
      averageMs: average(values),
      medianMs: median(values) ?? 0,
    }))
    .sort((left, right) => right.medianMs - left.medianMs || left.key.localeCompare(right.key));
}

function runnerKey(run: RunRecord): string {
  return run.routing?.runnerName ?? 'unknown';
}

function tierKey(run: RunRecord): string {
  return run.routing?.tier ?? 'unknown';
}

function modelKey(run: RunRecord, config: WakeConfig): string {
  const runnerName = run.routing?.runnerName;
  if (runnerName === undefined) {
    return 'unknown';
  }
  const runner = config.runners[runnerName];
  if (runner === undefined || runner.kind === 'fake') {
    return 'unknown';
  }
  return runner.models[run.action] ?? runner.models.default ?? runner.model;
}

function completedAtForItem(item: IssueStateRecord): string | undefined {
  const doneEntry = item.wake.stageHistory.find((entry) => entry.stage === 'done');
  if (doneEntry !== undefined) {
    return doneEntry.changedAt;
  }
  if (item.issue.state === 'closed') {
    return item.issue.updatedAt;
  }
  if (isTerminalStage(item.wake.stage)) {
    return item.wake.stageHistory.at(-1)?.changedAt ?? item.issue.updatedAt;
  }
  return undefined;
}

function startedAtForItem(item: IssueStateRecord): string | undefined {
  return item.issue.createdAt ?? item.wake.stageHistory[0]?.changedAt;
}

function completedWorkItemDurations(
  items: IssueStateRecord[],
  buckets: TimeBucket[],
): Array<{
  key: string;
  repo: string;
  issueNumber: number;
  durationMs: number;
  completedAt: string;
}> {
  const rows: Array<{
    key: string;
    repo: string;
    issueNumber: number;
    durationMs: number;
    completedAt: string;
  }> = [];
  for (const item of items) {
    const completedAt = completedAtForItem(item);
    const startedAt = startedAtForItem(item);
    if (
      completedAt === undefined ||
      startedAt === undefined ||
      !inMetricsWindow(completedAt, buckets)
    ) {
      continue;
    }
    const completedMs = Date.parse(completedAt);
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(completedMs) || !Number.isFinite(startedMs) || completedMs < startedMs) {
      continue;
    }
    rows.push({
      key: item.workItemKey,
      repo: item.issue.repo,
      issueNumber: item.issue.number,
      durationMs: completedMs - startedMs,
      completedAt,
    });
  }
  return rows.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

function buildMetricsSummary(
  runs: RunRecord[],
  workItemDurations: Array<{ durationMs: number }>,
): MetricsSummary {
  const runDurations = runs
    .map((run) => runDurationMs(run))
    .filter((duration): duration is number => duration !== undefined);
  return {
    totalRuns: runs.length,
    completedRuns: runs.filter((run) => run.status === 'completed').length,
    blockedRuns: runs.filter((run) => run.status === 'blocked').length,
    awaitingApprovalRuns: runs.filter((run) => run.status === 'awaiting-approval').length,
    failedRuns: runs.filter((run) => run.status === 'failed').length,
    totalTokens: runs.reduce((total, run) => total + runTokenTotal(run), 0),
    totalCostUsd: runs.reduce((total, run) => total + (run.tokenUsage?.costUsd ?? 0), 0),
    medianRunDurationMs: median(runDurations),
    completedWorkItems: workItemDurations.length,
    medianWorkItemDurationMs: median(workItemDurations.map((row) => row.durationMs)),
  };
}

export async function buildMetrics(input: {
  stateStore: StateStore;
  config: WakeConfig;
  now: Date;
  window?: string | undefined;
  metric?: string | undefined;
}) {
  const window = parseMetricsWindow(input.window);
  const metric = parseMetricsMetric(input.metric);
  const buckets = createTimeBuckets(window, input.now);
  const [allRuns, items] = await Promise.all([
    listRunsForBuckets(input.stateStore, buckets),
    input.stateStore.listIssueStates(),
  ]);
  const runs = allRuns.filter((run) => inMetricsWindow(run.startedAt, buckets));
  const workItemDurations = completedWorkItemDurations(items, buckets);
  const summary = buildMetricsSummary(runs, workItemDurations);

  const runCountsForBucket = (bucket: TimeBucket) => {
    const bucketRuns = runs.filter(
      (run) => findBucket(run.startedAt, buckets)?.bucket === bucket.bucket,
    );
    return {
      bucket: bucket.bucket,
      label: bucket.label,
      total: bucketRuns.length,
      completed: bucketRuns.filter((run) => run.status === 'completed').length,
      blocked: bucketRuns.filter((run) => run.status === 'blocked').length,
      awaitingApproval: bucketRuns.filter((run) => run.status === 'awaiting-approval').length,
      failed: bucketRuns.filter((run) => run.status === 'failed').length,
      other: bucketRuns.filter(
        (run) => !['completed', 'blocked', 'awaiting-approval', 'failed'].includes(run.status),
      ).length,
    };
  };

  const tokenCountsForBucket = (bucket: TimeBucket) => {
    const bucketRuns = runs.filter(
      (run) => findBucket(run.startedAt, buckets)?.bucket === bucket.bucket,
    );
    return {
      bucket: bucket.bucket,
      label: bucket.label,
      tokens: bucketRuns.reduce((total, run) => total + runTokenTotal(run), 0),
      inputTokens: bucketRuns.reduce((total, run) => total + (run.tokenUsage?.inputTokens ?? 0), 0),
      outputTokens: bucketRuns.reduce(
        (total, run) => total + (run.tokenUsage?.outputTokens ?? 0),
        0,
      ),
      cacheCreationInputTokens: bucketRuns.reduce(
        (total, run) => total + (run.tokenUsage?.cacheCreationInputTokens ?? 0),
        0,
      ),
      cacheReadInputTokens: bucketRuns.reduce(
        (total, run) => total + (run.tokenUsage?.cacheReadInputTokens ?? 0),
        0,
      ),
      costUsd: bucketRuns.reduce((total, run) => total + (run.tokenUsage?.costUsd ?? 0), 0),
    };
  };

  switch (metric) {
    case 'runs-by-status':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'run-counts' as const,
          group: 'status' as const,
          rows: groupCount(runs, (run) => run.status),
        },
      };
    case 'runs-by-status-over-time':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'runs-by-status-over-time' as const,
          rows: buckets.map(runCountsForBucket),
        },
      };
    case 'runs-by-action':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'run-counts' as const,
          group: 'action' as const,
          rows: groupCount(runs, (run) => run.action),
        },
      };
    case 'runs-by-repo':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'run-counts' as const,
          group: 'repo' as const,
          rows: groupCount(runs, (run) => run.repo),
        },
      };
    case 'runs-by-runner':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'run-counts' as const,
          group: 'runner' as const,
          rows: groupCount(runs, runnerKey),
        },
      };
    case 'runs-by-model':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'run-counts' as const,
          group: 'model' as const,
          rows: groupCount(runs, (run) => modelKey(run, input.config)),
        },
      };
    case 'runs-by-tier':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'run-counts' as const,
          group: 'tier' as const,
          rows: groupCount(runs, tierKey),
        },
      };
    case 'tokens-over-time':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: { kind: 'tokens-over-time' as const, rows: buckets.map(tokenCountsForBucket) },
      };
    case 'tokens-by-action':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'token-counts' as const,
          group: 'action' as const,
          rows: groupTokens(runs, (run) => run.action),
        },
      };
    case 'tokens-by-runner':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'token-counts' as const,
          group: 'runner' as const,
          rows: groupTokens(runs, runnerKey),
        },
      };
    case 'tokens-by-model':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'token-counts' as const,
          group: 'model' as const,
          rows: groupTokens(runs, (run) => modelKey(run, input.config)),
        },
      };
    case 'duration-by-action':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'durations' as const,
          group: 'action' as const,
          rows: groupDurations(runs, (run) => run.action),
        },
      };
    case 'duration-over-time':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'duration-over-time' as const,
          rows: buckets.map((bucket) => {
            const values = runs
              .filter((run) => findBucket(run.startedAt, buckets)?.bucket === bucket.bucket)
              .map((run) => runDurationMs(run))
              .filter((duration): duration is number => duration !== undefined);
            return {
              bucket: bucket.bucket,
              label: bucket.label,
              count: values.length,
              totalMs: values.reduce((total, value) => total + value, 0),
              averageMs: average(values),
              medianMs: median(values) ?? 0,
            };
          }),
        },
      };
    case 'work-items-over-time':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: {
          kind: 'work-items-over-time' as const,
          rows: buckets.map((bucket) => ({
            bucket: bucket.bucket,
            label: bucket.label,
            completed: workItemDurations.filter(
              (row) => findBucket(row.completedAt, buckets)?.bucket === bucket.bucket,
            ).length,
          })),
        },
      };
    case 'work-item-durations':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: { kind: 'work-item-durations' as const, rows: workItemDurations },
      };
    case 'runs-over-time':
      return {
        window,
        metric,
        generatedAt: input.now.toISOString(),
        summary,
        detail: { kind: 'runs-over-time' as const, rows: buckets.map(runCountsForBucket) },
      };
  }
}

const secretKeyPattern = /token|secret|key|password/i;

function redact(value: unknown, keyHint = ''): unknown {
  if (secretKeyPattern.test(keyHint) && typeof value === 'string') {
    return '***redacted***';
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redact(entry, key);
    }
    return out;
  }
  return value;
}

export async function buildConfigView(input: {
  config: WakeConfig;
  stateStore: StateStore;
  now: Date;
}) {
  const ledger = await input.stateStore.readLedger();
  const runnerHealth = ledger?.runners ?? {};

  const routingTable = Object.entries(input.config.stages).map(([stage, route]) => {
    const tier = route.tier ?? input.config.defaultTier;
    const candidates = input.config.tiers[tier] ?? [];
    const runnerName = route.runner ?? candidates[0];
    const runner = runnerName !== undefined ? input.config.runners[runnerName] : undefined;
    // Full fallback order for the tier (#67), each candidate's current pause
    // state so the UI can show not just who's active but who Wake would fall
    // sideways to next, and rotate back to once a pause expires.
    const candidateHealth = candidates.map((name) => {
      const health = runnerHealth[name];
      const pausedUntil = health?.pausedUntil;
      const paused = pausedUntil !== undefined && Date.parse(pausedUntil) > input.now.getTime();
      return { runnerName: name, paused, pausedUntil };
    });
    return {
      stage,
      action: route.action,
      tier,
      runnerName,
      runnerKind: runner?.kind,
      model: runner !== undefined && runner.kind !== 'fake' ? runner.model : undefined,
      timeoutMs: runner !== undefined && runner.kind !== 'fake' ? runner.timeoutMs : undefined,
      candidates: candidateHealth,
    };
  });

  return { config: redact(input.config), routingTable };
}

async function dirSize(path: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return { files: 0, bytes: 0 };
  }

  for (const entry of entries) {
    const entryPath = join(path, entry);
    const info = await stat(entryPath).catch(() => null);
    if (info === null) {
      continue;
    }
    if (info.isDirectory()) {
      const nested = await dirSize(entryPath);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += info.size;
    }
  }

  return { files, bytes };
}

export async function buildHealth(input: {
  stateStore: StateStore;
  config: WakeConfig;
  now: Date;
}) {
  const lock = await readLockInfo(input.stateStore.paths.tickLockFile, input.now);
  const staleAfterMs = 15 * 60 * 1000;
  const paused = await input.stateStore.isPaused();
  const ledger = await input.stateStore.readLedger();
  const sourceStates = await listSourceStates(input.stateStore.paths.sourceStateRoot);

  const storageDirs = ['events', 'state', 'runs', 'workspaces'] as const;
  const storageSizes = await Promise.all(
    storageDirs.map((dir) => dirSize(join(input.stateStore.paths.wakeRoot, dir))),
  );
  const storage = Object.fromEntries(storageDirs.map((dir, i) => [dir, storageSizes[i]]));

  const items = await input.stateStore.listIssueStates();
  const integrityChecks = await Promise.all(
    items
      .filter((item) => item.wake.workspacePath !== undefined)
      .map(async (item) => {
        const exists = await stat(item.wake.workspacePath!)
          .then(() => true)
          .catch(() => false);
        return exists
          ? null
          : {
              path: item.wake.workspacePath!,
              problem: `workspacePath missing for ${item.workItemKey}`,
            };
      }),
  );
  const integrityIssues = integrityChecks.filter(
    (issue): issue is { path: string; problem: string } => issue !== null,
  );

  return {
    lock: {
      ...lock,
      stale: lock.present && ((lock.ageMs ?? 0) >= staleAfterMs || lock.pidAlive === false),
      staleAfterMs,
    },
    pause: { paused, runnerHealth: ledger?.runners ?? {} },
    sources: sourceStates.map((source) => ({
      ...source,
      ageMs: input.now.getTime() - Date.parse(source.lastSuccessfulPollAt),
    })),
    storage,
    integrityIssues,
  };
}

export async function buildWorkspaces(input: { stateStore: StateStore }) {
  const items = await input.stateStore.listIssueStates();
  const byWorkspacePath = new Map(
    items
      .filter((item) => item.wake.workspacePath !== undefined)
      .map((item) => [item.wake.workspacePath, item]),
  );

  const workspaceRoot = input.stateStore.paths.workspaceRoot;
  const workspaces: {
    path: string;
    repo?: string | undefined;
    issueNumber?: number | undefined;
    size: number;
    orphan: boolean;
  }[] = [];

  const repoDirs = await readdir(workspaceRoot).catch(() => []);

  for (const repoDir of repoDirs) {
    const repoPath = join(workspaceRoot, repoDir);
    const issueDirs = await readdir(repoPath).catch(() => []);
    for (const issueDir of issueDirs) {
      const fullPath = join(repoPath, issueDir);
      const size = await dirSize(fullPath);
      const matched = byWorkspacePath.get(fullPath);
      workspaces.push({
        path: fullPath,
        repo: matched?.issue.repo,
        issueNumber: matched?.issue.number,
        size: size.bytes,
        orphan: matched === undefined,
      });
    }
  }

  return workspaces;
}
