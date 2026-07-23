import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createWakePaths } from '../../src/lib/paths.js';

describe('createWakePaths', () => {
  const wakeRoot = '/tmp/wake-home';
  const paths = createWakePaths(wakeRoot);

  it('keeps user-facing paths at the visible wakeRoot', () => {
    expect(paths.configFile).toBe(join(wakeRoot, 'config.yaml'));
    expect(paths.workflowsConfigFile).toBe(join(wakeRoot, 'config.workflows.yaml'));
    expect(paths.workspaceRoot).toBe(join(wakeRoot, 'workspaces'));
    expect(paths.workspaceDir('work-1')).toBe(join(wakeRoot, 'workspaces', 'work-1'));
  });

  it('moves internal/durable paths under .wake/', () => {
    const dataRoot = join(wakeRoot, '.wake');
    expect(paths.containerHomeRoot).toBe(join(dataRoot, 'container-home'));
    expect(paths.ledgerFile).toBe(join(dataRoot, 'ledger.json'));
    expect(paths.pauseFile).toBe(join(dataRoot, 'PAUSE'));
    expect(paths.tickRequestFile).toBe(join(dataRoot, 'control', 'tick-request.json'));
    expect(paths.tickLockFile).toBe(join(dataRoot, 'locks', 'tick.lock'));
    expect(paths.runnerLockFile).toBe(join(dataRoot, 'locks', 'runner.lock'));
    expect(paths.issueFixtureFile).toBe(join(dataRoot, 'fixtures', 'issues.json'));
    expect(paths.transcriptsRoot).toBe(join(dataRoot, 'transcripts'));
    expect(paths.transcriptWorkDir('work-1')).toBe(join(dataRoot, 'transcripts', 'work-1'));
    expect(paths.reposRoot).toBe(join(dataRoot, 'repos'));
    expect(paths.repoRoot('org/repo')).toBe(join(dataRoot, 'repos', 'org__repo'));
    expect(paths.sourceStateRoot).toBe(join(dataRoot, 'sources'));
    expect(paths.workItemStateFile('work-1')).toBe(join(dataRoot, 'state', 'work-1.json'));
    expect(paths.archivedWorkItemStateFile('work-1')).toBe(
      join(dataRoot, 'state', 'archive', 'work-1.json'),
    );
    expect(paths.runFile('run-1')).toBe(join(dataRoot, 'runs', 'run-1.json'));
    expect(paths.eventFile('2026-07-22')).toBe(join(dataRoot, 'events', '2026-07-22.jsonl'));
    expect(paths.eventEnvelopeFile('evt-1')).toBe(join(dataRoot, 'events-by-id', 'evt-1.json'));
    expect(paths.logFile('2026-07-22')).toBe(join(dataRoot, 'logs', '2026-07-22.log'));
    expect(paths.resourceIndexRoot).toBe(join(dataRoot, 'state', 'index'));
    expect(paths.resourceIndexShardFile('a1')).toBe(join(dataRoot, 'state', 'index', 'a1.json'));
    expect(paths.controlPlaneUiUrlFile).toBe(join(dataRoot, 'control-plane-ui-url'));
  });
});
