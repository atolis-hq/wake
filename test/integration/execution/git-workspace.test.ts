import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runId } from '../../../src/execution/contracts/identifiers.js';
import { GitWorkspaceProvider } from '../../../src/execution/infrastructure/workspace/git-workspace.js';
import { resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

describe('GitWorkspaceProvider', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
    );
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

  it('creates and attests the WorkItem branch for a branch workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const commands: string[][] = [];
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        commands.push([...args]);
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
    );

    const workItemId = workId('work-branch');
    const lease = await provider.acquire({
      runId: runId('run-branch'),
      mode: 'branch',
      workItemId,
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });

    expect(lease.branch).toBe(workItemId);
    expect(commands).toEqual([
      ['clone', 'https://github.com/atolis-hq/wake-test.git', lease.path],
      ['-C', lease.path, 'switch', '--create', workItemId],
    ]);
    await lease.release();
    await expect(access(lease.path)).resolves.toBeUndefined();
    await expect(
      access(join(root, '.wake-workspace-ownership', `${lease.workspaceId}.json`)),
    ).resolves.toBeUndefined();
  });

  it('reuses a retained branch workspace for a follow-up activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const commands: string[][] = [];
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        commands.push([...args]);
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
    );
    const workItemId = workId('follow-up');
    const request = {
      mode: 'branch' as const,
      workItemId,
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    };

    const first = await provider.acquire({ ...request, runId: runId('run-first') });
    await first.release();
    const followUp = await provider.acquire({ ...request, runId: runId('run-follow-up') });

    expect(followUp.path).toBe(first.path);
    expect(commands).toEqual([
      ['clone', 'https://github.com/atolis-hq/wake-test.git', first.path],
      ['-C', first.path, 'switch', '--create', workItemId],
      ['-C', first.path, 'switch', workItemId],
    ]);
  });

  it('records ownership before cloning and removes a read-only workspace when the lease releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const workItemId = workId('one');
    const repositoryResourceId = resId('workspace-resource');
    const workspaceId = `${workItemId}-read-only-https-github-com-atolis-hq-wake-test-git`;
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
