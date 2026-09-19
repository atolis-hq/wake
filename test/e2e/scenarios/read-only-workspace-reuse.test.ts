import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect } from 'vitest';
import { runId } from '../../../src/execution/contracts/identifiers.js';
import { GitWorkspaceProvider } from '../../../src/execution/infrastructure/workspace/git-workspace.js';
import { resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { defineScenario } from '../support/scenario.js';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

defineScenario(
  {
    id: 'E2E-EXEC-WORKSPACE-004',
    title: 'a repeated read-only turn reuses its prepared checkout',
    given: ['an open WorkItem with a local Git repository and a read-only workspace hook'],
    when: ['two turns acquire and release that WorkItem workspace'],
    then: [
      'the second turn uses the same checkout without another clone and runs preparation again',
    ],
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-read-only-e2e-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await execFileAsync('git', ['init', repository]);
    await writeFile(join(repository, 'README.md'), 'fixture\n');
    await execFileAsync('git', ['-C', repository, 'add', 'README.md']);
    await execFileAsync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Wake E2E',
      '-c',
      'user.email=wake@example.test',
      'commit',
      '-m',
      'fixture',
    ]);
    let clones = 0;
    const provider = new GitWorkspaceProvider(
      join(root, 'workspaces'),
      { cloneLocator: async () => repository },
      async (arguments_, signal) => {
        if (arguments_[0] === 'clone') clones += 1;
        await execFileAsync('git', arguments_, { signal });
      },
      undefined,
      {
        command: `${JSON.stringify(process.execPath)} -e "require('node:fs').appendFileSync('.prepared', 'x')"`,
        timeoutMs: 10_000,
      },
    );
    const request = {
      signal: new AbortController().signal,
      mode: 'read-only' as const,
      workItemId: workId('read-only-e2e'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'wake-test/read-only#1' },
        capabilities: [],
      },
    };
    const first = await provider.acquire({ ...request, runId: runId('run-read-only-e2e-first') });
    await first.release();
    const second = await provider.acquire({ ...request, runId: runId('run-read-only-e2e-second') });
    expect(second.path).toBe(first.path);
    expect(clones).toBe(1);
    await expect(readFile(join(second.path, '.prepared'), 'utf8')).resolves.toBe('xx');
    await second.release();
  },
  30_000,
);
