import { join } from 'node:path';

function sanitizeRepo(repo: string): string {
  return repo.replace(/[\\/]/g, '__');
}

export function createWakePaths(wakeRoot: string) {
  return {
    wakeRoot,
    configFile: join(wakeRoot, 'config.json'),
    ledgerFile: join(wakeRoot, 'ledger.json'),
    pauseFile: join(wakeRoot, 'PAUSE'),
    tickLockFile: join(wakeRoot, 'locks', 'tick.lock'),
    issueFixtureFile: join(wakeRoot, 'fixtures', 'issues.json'),
    workspaceRoot: join(wakeRoot, 'workspaces'),
    issueStateFile: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'state', sanitizeRepo(repo), `${issueNumber}.json`),
    runFile: (runId: string) => join(wakeRoot, 'runs', `${runId}.json`),
    eventFile: (date: string) => join(wakeRoot, 'events', `${date}.jsonl`),
    logFile: (date: string) => join(wakeRoot, 'logs', `${date}.log`),
    workspaceDir: (repo: string, issueNumber: number) =>
      join(wakeRoot, 'workspaces', sanitizeRepo(repo), String(issueNumber)),
  };
}
