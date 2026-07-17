import { join } from 'node:path';

export function sanitizeRepo(repo: string): string {
  return repo.replace(/[\\/]/g, '__');
}

export function sanitizePathKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '__');
}

export type WakePaths = ReturnType<typeof createWakePaths>;

export function createWakePaths(wakeRoot: string) {
  return {
    wakeRoot,
    containerHomeRoot: join(wakeRoot, 'container-home'),
    configFile: join(wakeRoot, 'config.json'),
    ledgerFile: join(wakeRoot, 'ledger.json'),
    pauseFile: join(wakeRoot, 'PAUSE'),
    tickLockFile: join(wakeRoot, 'locks', 'tick.lock'),
    issueFixtureFile: join(wakeRoot, 'fixtures', 'issues.json'),
    workspaceRoot: join(wakeRoot, 'workspaces'),
    transcriptsRoot: join(wakeRoot, 'transcripts'),
    reposRoot: join(wakeRoot, 'repos'),
    repoRoot: (repo: string) => join(wakeRoot, 'repos', sanitizeRepo(repo)),
    sourceStateRoot: join(wakeRoot, 'sources'),
    // Keyed on the minted work id, which is filename-safe by construction
    // (src/lib/work-id.ts) — hence no sanitizePathKey here. No durable path
    // embeds a provider, repo, or issue segment (spec §3).
    workItemStateFile: (workId: string) => join(wakeRoot, 'state', `${workId}.json`),
    archivedWorkItemStateFile: (workId: string) =>
      join(wakeRoot, 'state', 'archive', `${workId}.json`),
    sourceStateFile: (source: string, key: string) =>
      join(wakeRoot, 'sources', sanitizePathKey(source), `${sanitizePathKey(key)}.json`),
    runFile: (runId: string) => join(wakeRoot, 'runs', `${runId}.json`),
    runDateFile: (date: string, runId: string) => join(wakeRoot, 'runs', 'by-date', date, `${runId}.json`),
    eventFile: (date: string) => join(wakeRoot, 'events', `${date}.jsonl`),
    eventEnvelopeFile: (eventId: string) =>
      join(wakeRoot, 'events-by-id', `${sanitizePathKey(eventId)}.json`),
    logFile: (date: string) => join(wakeRoot, 'logs', `${date}.log`),
    // Workspaces and transcripts are ephemeral scratch rather than durable
    // state, but they re-key to the work id anyway: they are 1:1 with a work
    // item, not a ticket, and a ticket-shaped path here would preserve the
    // second ticket-shaped identity this change exists to remove (spec §3).
    workspaceDir: (workId: string) => join(wakeRoot, 'workspaces', workId),
    transcriptWorkDir: (workId: string) => join(wakeRoot, 'transcripts', workId),
    transcriptSessionDir: (workId: string, sessionKey: string) =>
      join(wakeRoot, 'transcripts', workId, sanitizePathKey(sessionKey)),
    resourceIndexRoot: join(wakeRoot, 'state', 'index'),
    resourceIndexShardFile: (shard: string) => join(wakeRoot, 'state', 'index', `${shard}.json`),
  };
}
