import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runId } from '../../../src-next/execution/contracts/identifiers.js';
import { GitWorkspaceProvider } from '../../../src-next/execution/infrastructure/workspace/git-workspace.js';
import { resourceKind } from '../../../src-next/resources/index.js';
import { resId, workId } from '../../support/identities.js';

describe('GitWorkspaceProvider', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('clones a repository into a work-item workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const commands: readonly string[][] = [];
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        (commands as string[][]).push([...args]);
      },
    );
    const lease = await provider.acquire({
      runId: runId('run-0'),
      mode: 'read-only',
      workItemId: workId('one'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });
    expect((commands as string[][])[0]![0]).toBe('clone');
    expect((commands as string[][])[0]![1]).toBe('https://github.com/atolis-hq/wake-test.git');
    expect((commands as string[][])[0]![2]).toBe(lease.path);
    await lease.release();
  });

  it('records ownership before cloning and removes it when the lease releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const workItemId = workId('one');
    const repositoryResourceId = resId('workspace-resource');
    const workspaceId = `${workItemId}-https-github-com-atolis-hq-wake-test-git`;
    const markerPath = join(root, '.wake-workspace-ownership', `${workspaceId}.json`);
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        const workspacePath = args[2]!;
        const marker = JSON.parse(await readFile(markerPath, 'utf8'));
        expect(marker).toEqual({
          runId: 'run-1',
          workItemId,
          repositoryResourceId,
          mode: 'read-only',
          workspaceId,
          path: workspacePath,
        });
        await mkdir(join(workspacePath, '.git'), { recursive: true });
      },
    );

    const lease = await provider.acquire({
      runId: runId('run-1'),
      mode: 'read-only',
      workItemId,
      repositoryResource: {
        resourceId: repositoryResourceId,
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });

    await lease.release();
    await lease.release();
    await expect(access(lease.path)).rejects.toThrow();
    await expect(access(markerPath)).rejects.toThrow();
  });
});
