import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isTerminalStage } from '../../domain/stages.js';
import type {
  EventEnvelope,
  IssueStateRecord,
  RunRecord,
  WakeConfig,
} from '../../domain/types.js';
import type { createStateStore } from '../fs/state-store.js';

type StateStore = ReturnType<typeof createStateStore>;

export type BoardCondition =
  | 'needs-human'
  | 'active'
  | 'ready'
  | 'waiting'
  | 'stalled'
  | 'finished';

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
): Promise<{ present: boolean; pid?: number; acquiredAt?: string; ageMs?: number; pidAlive?: boolean }> {
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
  runs: RunRecord[],
  config: WakeConfig,
): { condition: BoardCondition; reason: string } {
  const stage = item.wake.stage;

  if (isTerminalStage(stage) || item.issue.state === 'closed') {
    return { condition: 'finished', reason: 'terminal stage' };
  }

  const hasRunningRun = runs.some(
    (run) =>
      run.repo === item.issue.repo &&
      run.issueNumber === item.issue.number &&
      run.status === 'running',
  );
  if (hasRunningRun) {
    return { condition: 'active', reason: 'run in flight' };
  }

  const lastRun = runs
    .filter((run) => run.repo === item.issue.repo && run.issueNumber === item.issue.number)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1);

  if (lastRun?.sentinel === 'BLOCKED' || lastRun?.sentinel === 'AWAITING_APPROVAL') {
    return { condition: 'needs-human', reason: `sentinel ${lastRun?.sentinel ?? stage}` };
  }

  const hasRoute = config.stages[stage] !== undefined;
  if (!hasRoute) {
    return { condition: 'stalled', reason: `no route configured for stage "${stage}"` };
  }

  if (lastRun?.sentinel === 'FAILED') {
    return { condition: 'waiting', reason: 'last run failed; awaiting operator/retry policy' };
  }

  return { condition: 'ready', reason: 'has a route and no blocking condition' };
}

function timeInStageMs(item: IssueStateRecord, now: Date): number {
  const lastChange = item.wake.stageHistory.at(-1)?.changedAt ?? item.wake.syncedAt;
  return now.getTime() - Date.parse(lastChange);
}

export async function buildBoard(input: {
  stateStore: StateStore;
  config: WakeConfig;
  now: Date;
}) {
  const [items, runs] = await Promise.all([
    input.stateStore.listIssueStates(),
    input.stateStore.listRunRecords(),
  ]);

  return items.map((item) => {
    const { condition, reason } = deriveCondition(item, runs, input.config);
    const lastRun = runs
      .filter(
        (run) => run.repo === item.issue.repo && run.issueNumber === item.issue.number,
      )
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .at(-1);

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
  const [ledger, paused, allEvents, runs, board] = await Promise.all([
    input.stateStore.readLedger(),
    input.stateStore.isPaused(),
    input.stateStore.listEventEnvelopes(),
    input.stateStore.listRunRecords(),
    buildBoard(input),
  ]);

  const lock = await readLockInfo(input.stateStore.paths.tickLockFile, input.now);
  const lockLive = lock.present && lock.pidAlive === true;

  // A quota-paused runner (#67) no longer stops the loop - routing falls
  // sideways to another candidate in the tier, so only the manual pause file
  // is a hard stop here. Per-runner health is surfaced separately below.
  const loopState: 'paused' | 'ticking' | 'idle' = paused
    ? 'paused'
    : lockLive
      ? 'ticking'
      : 'idle';
  const runnerHealth = ledger?.runners ?? {};

  const lastEvent = allEvents
    .slice()
    .sort((left, right) => left.ingestedAt.localeCompare(right.ingestedAt))
    .at(-1);
  const lastRun = runs
    .slice()
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .at(-1);

  const counters: Record<BoardCondition, number> = {
    'needs-human': 0,
    active: 0,
    ready: 0,
    waiting: 0,
    stalled: 0,
    finished: 0,
  };
  for (const card of board) {
    counters[card.condition] += 1;
  }

  const intervalMs = input.config.scheduler.intervalMs;
  const sourceStates = await listSourceStates(input.stateStore.paths.sourceStateRoot);
  const worstAgeMs = sourceStates.length === 0
    ? undefined
    : Math.max(
        ...sourceStates.map((source) => input.now.getTime() - Date.parse(source.lastSuccessfulPollAt)),
      );

  const sourceFreshness = worstAgeMs === undefined
    ? { level: 'unknown' as const }
    : {
        ageMs: worstAgeMs,
        level: worstAgeMs > intervalMs * 10 ? ('red' as const) : worstAgeMs > intervalMs * 3 ? ('amber' as const) : ('ok' as const),
      };

  return {
    loopState,
    paused,
    runnerHealth,
    lock,
    lastEvent: lastEvent === undefined
      ? undefined
      : { at: lastEvent.ingestedAt, type: lastEvent.sourceEventType, workItemKey: lastEvent.workItemKey },
    lastRun: lastRun === undefined
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
    runsToday: countToday(runs.map((run) => run.startedAt), input.now),
    failuresToday: countToday(
      runs.filter((run) => run.status === 'failed').map((run) => run.startedAt),
      input.now,
    ),
    costUsdToday: sumToday(
      runs.map((run) => ({ at: run.startedAt, value: run.tokenUsage?.costUsd ?? 0 })),
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
          const raw = JSON.parse(await readFile(join(sourceStateRoot, sourceDir, file), 'utf8')) as Record<
            string,
            unknown
          >;
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
  repo: string;
  issueNumber: number;
}) {
  const item = await input.stateStore.readIssueState(input.repo, input.issueNumber);
  if (item === null) {
    return null;
  }

  const allRuns = await input.stateStore.listRunRecords();
  const runs = allRuns
    .filter((run) => run.repo === input.repo && run.issueNumber === input.issueNumber)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

  const events = await input.stateStore.listEventEnvelopesForWorkItem(item.workItemKey, 50);

  return { item, runs, events };
}

export async function buildEventsFeed(input: {
  stateStore: StateStore;
  limit?: number | undefined;
  workItemKey?: string | undefined;
  direction?: EventEnvelope['direction'] | undefined;
  type?: string | undefined;
}) {
  const events = await input.stateStore.listEventEnvelopes();
  const filtered = events
    .filter((event) => input.workItemKey === undefined || event.workItemKey === input.workItemKey)
    .filter((event) => input.direction === undefined || event.direction === input.direction)
    .filter((event) => input.type === undefined || event.sourceEventType === input.type)
    .sort((left, right) => right.ingestedAt.localeCompare(left.ingestedAt));

  const limit = input.limit ?? 200;
  return filtered.slice(0, limit);
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
        const exists = await stat(item.wake.workspacePath!).then(() => true).catch(() => false);
        return exists ? null : { path: item.wake.workspacePath!, problem: `workspacePath missing for ${item.workItemKey}` };
      }),
  );
  const integrityIssues = integrityChecks.filter((issue): issue is { path: string; problem: string } => issue !== null);

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
    items.filter((item) => item.wake.workspacePath !== undefined).map((item) => [item.wake.workspacePath, item]),
  );

  const workspaceRoot = input.stateStore.paths.workspaceRoot;
  const workspaces: { path: string; repo?: string | undefined; issueNumber?: number | undefined; size: number; orphan: boolean }[] = [];

  let repoDirs: string[] = [];
  try {
    repoDirs = await readdir(workspaceRoot);
  } catch {
    repoDirs = [];
  }

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
