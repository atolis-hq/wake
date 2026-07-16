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
    issueStateFile: (source: string, repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', sanitizePathKey(source), sanitizeRepo(repo), `${issueNumber}.json`),
    archivedIssueStateFile: (source: string, repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', sanitizePathKey(source), 'archive', sanitizeRepo(repo), `${issueNumber}.json`),
    legacyIssueStateFile: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', sanitizeRepo(repo), `${issueNumber}.json`),
    archivedLegacyIssueStateFile: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', 'archive', 'legacy', sanitizeRepo(repo), `${issueNumber}.json`),
    sourceStateFile: (source: string, key: string) =>
      join(wakeRoot, 'sources', sanitizePathKey(source), `${sanitizePathKey(key)}.json`),
    runFile: (runId: string) => join(wakeRoot, 'runs', `${runId}.json`),
    runDateFile: (date: string, runId: string) => join(wakeRoot, 'runs', 'by-date', date, `${runId}.json`),
    eventFile: (date: string) => join(wakeRoot, 'events', `${date}.jsonl`),
    eventEnvelopeFile: (eventId: string) =>
      join(wakeRoot, 'events-by-id', `${sanitizePathKey(eventId)}.json`),
    logFile: (date: string) => join(wakeRoot, 'logs', `${date}.log`),
    workspaceDir: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'workspaces', sanitizeRepo(repo), String(issueNumber)),
    transcriptIssueDir: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'transcripts', sanitizeRepo(repo), String(issueNumber)),
    transcriptSessionDir: (repo: string, issueNumber: number, sessionKey: string) =>
      join(wakeRoot, 'transcripts', sanitizeRepo(repo), String(issueNumber), sanitizePathKey(sessionKey)),
    resourceIndexRoot: join(wakeRoot, 'state', 'index'),
    resourceIndexShardFile: (shard: string) => join(wakeRoot, 'state', 'index', `${shard}.json`),
  };
}
