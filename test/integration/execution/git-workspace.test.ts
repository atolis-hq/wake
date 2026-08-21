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

  it.each(['branch', 'read-only'] as const)(
    'runs the prepare hook in each %s workspace before returning its lease',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
      roots.push(root);
      const outputName = `prepared-${mode}`;
      const provider = new GitWorkspaceProvider(
        root,
        { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
        async (args) => {
          if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
        },
        undefined,
        { command: `printf ${outputName} > .wake-prepare-result`, timeoutMs: 1_000 },
      );

      const lease = await provider.acquire({
        runId: runId(`run-${mode}`),
        mode,
        workItemId: workId(`prepare-${mode}`),
        repositoryResource: {
          resourceId: resId('workspace-resource'),
          kind: resourceKind('issue'),
          externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
          capabilities: [],
        },
      });

      await expect(readFile(join(lease.path, '.wake-prepare-result'), 'utf8')).resolves.toBe(
        outputName,
      );
    },
  );

  it('does not run a prepare command when it is not configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
    );
    const lease = await provider.acquire({
      runId: runId('run-no-prepare'),
      mode: 'read-only',
      workItemId: workId('no-prepare'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });

    await expect(access(join(lease.path, '.wake-prepare-result'))).rejects.toThrow();
  });

  it('runs the prepare hook again when a retained branch workspace is reacquired', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
      undefined,
      { command: 'printf prepared >> .wake-prepare-result', timeoutMs: 1_000 },
    );
    const request = {
      mode: 'branch' as const,
      workItemId: workId('prepare-reacquire'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    };

    const first = await provider.acquire({ ...request, runId: runId('run-prepare-first') });
    await first.release();
    const second = await provider.acquire({ ...request, runId: runId('run-prepare-second') });

    await expect(readFile(join(second.path, '.wake-prepare-result'), 'utf8')).resolves.toBe(
      'preparedprepared',
    );
  });

  it('fails acquisition with the final combined prepare output tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const diagnostic = 'diagnostic-at-the-end';
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
      undefined,
      {
        command: `printf 'discard-this-prefix${'x'.repeat(5_000)}'; printf '${diagnostic}' >&2; exit 7`,
        timeoutMs: 1_000,
      },
    );

    const acquisition = provider.acquire({
      runId: runId('run-prepare-failure'),
      mode: 'read-only',
      workItemId: workId('prepare-failure'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });
    const error = await acquisition.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      new RegExp(`exited with code 7[\\s\\S]*${diagnostic}`),
    );
    expect((error as Error).message.split(':\n')[1]).not.toContain('discard-this-prefix');
  });

  it('honors the prepare command timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
      undefined,
      { command: 'sleep 5', timeoutMs: 20 },
    );

    await expect(
      provider.acquire({
        runId: runId('run-prepare-timeout'),
        mode: 'read-only',
        workItemId: workId('prepare-timeout'),
        repositoryResource: {
          resourceId: resId('workspace-resource'),
          kind: resourceKind('issue'),
          externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
          capabilities: [],
        },
      }),
    ).rejects.toThrow(/prepare hook.*timed out/i);
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
