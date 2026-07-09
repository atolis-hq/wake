import { join } from 'node:path';

function sanitizeRepo(repo: string): string {
  return repo.replace(/[\\/]/g, '__');
}

function sanitizePathKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '__');
}

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
    reposRoot: join(wakeRoot, 'repos'),
    repoRoot: (repo: string) => join(wakeRoot, 'repos', sanitizeRepo(repo)),
    sourceStateRoot: join(wakeRoot, 'sources'),
    issueStateFile: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', sanitizeRepo(repo), `${issueNumber}.json`),
    sourceStateFile: (source: string, key: string) =>
      join(wakeRoot, 'sources', sanitizePathKey(source), `${sanitizePathKey(key)}.json`),
    runFile: (runId: string) => join(wakeRoot, 'runs', `${runId}.json`),
    eventFile: (date: string) => join(wakeRoot, 'events', `${date}.jsonl`),
    eventEnvelopeFile: (eventId: string) =>
      join(wakeRoot, 'events-by-id', `${sanitizePathKey(eventId)}.json`),
    logFile: (date: string) => join(wakeRoot, 'logs', `${date}.log`),
    workspaceDir: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'workspaces', sanitizeRepo(repo), String(issueNumber)),
  };
}
