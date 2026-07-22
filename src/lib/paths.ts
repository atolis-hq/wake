import { join } from 'node:path';

export function sanitizeRepo(repo: string): string {
  return repo.replace(/[\\/]/g, '__');
}

export function sanitizePathKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '__');
}

export type WakePaths = ReturnType<typeof createWakePaths>;

export function createWakePaths(wakeRoot: string) {
  const dataRoot = join(wakeRoot, '.wake');

  return {
    wakeRoot,
    dataRoot,
    containerHomeRoot: join(dataRoot, 'container-home'),
    configFile: join(wakeRoot, 'config.json'),
    ledgerFile: join(dataRoot, 'ledger.json'),
    pauseFile: join(dataRoot, 'PAUSE'),
    tickRequestFile: join(dataRoot, 'control', 'tick-request.json'),
    tickLockFile: join(dataRoot, 'locks', 'tick.lock'),
    runnerLockFile: join(dataRoot, 'locks', 'runner.lock'),
    issueFixtureFile: join(dataRoot, 'fixtures', 'issues.json'),
    workspaceRoot: join(wakeRoot, 'workspaces'),
    transcriptsRoot: join(dataRoot, 'transcripts'),
    reposRoot: join(dataRoot, 'repos'),
    repoRoot: (repo: string) => join(dataRoot, 'repos', sanitizeRepo(repo)),
    sourceStateRoot: join(dataRoot, 'sources'),
    // Keyed on the minted work id, which is filename-safe by construction
    // (src/lib/work-id.ts) — hence no sanitizePathKey here. No durable path
    // embeds a provider, repo, or issue segment (spec §3).
    workItemStateFile: (workId: string) => join(dataRoot, 'state', `${workId}.json`),
    archivedWorkItemStateFile: (workId: string) =>
      join(dataRoot, 'state', 'archive', `${workId}.json`),
    sourceStateFile: (source: string, key: string) =>
      join(dataRoot, 'sources', sanitizePathKey(source), `${sanitizePathKey(key)}.json`),
    runFile: (runId: string) => join(dataRoot, 'runs', `${runId}.json`),
    runDateFile: (date: string, runId: string) =>
      join(dataRoot, 'runs', 'by-date', date, `${runId}.json`),
    eventFile: (date: string) => join(dataRoot, 'events', `${date}.jsonl`),
    eventEnvelopeFile: (eventId: string) =>
      join(dataRoot, 'events-by-id', `${sanitizePathKey(eventId)}.json`),
    logFile: (date: string) => join(dataRoot, 'logs', `${date}.log`),
    // Workspaces and transcripts are ephemeral scratch rather than durable
    // state, but they re-key to the work id anyway: they are 1:1 with a work
    // item, not a ticket, and a ticket-shaped path here would preserve the
    // second ticket-shaped identity this change exists to remove (spec §3).
    workspaceDir: (workId: string) => join(wakeRoot, 'workspaces', workId),
    transcriptWorkDir: (workId: string) => join(dataRoot, 'transcripts', workId),
    transcriptSessionDir: (workId: string, sessionKey: string) =>
      join(dataRoot, 'transcripts', workId, sanitizePathKey(sessionKey)),
    resourceIndexRoot: join(dataRoot, 'state', 'index'),
    resourceIndexShardFile: (shard: string) => join(dataRoot, 'state', 'index', `${shard}.json`),
  };
}
