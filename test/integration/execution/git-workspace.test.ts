import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runId } from '../../../src/execution/contracts/identifiers.js';
import { GitWorkspaceProvider } from '../../../src/execution/infrastructure/workspace/git-workspace.js';
import { resourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

const execFileAsync = promisify(execFile);

describe('GitWorkspaceProvider', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
    );
  });

  it('propagates the acquisition signal to an in-flight git clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    let reportCloneEntered!: () => void;
    const cloneEntered = new Promise<void>((resolve) => {
      reportCloneEntered = resolve;
    });
    let receivedSignal: AbortSignal | undefined;
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (_args, signal) => {
        receivedSignal = signal;
        reportCloneEntered();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    );
    const controller = new AbortController();
    const cancellation = new Error('workspace cancelled');

    const acquisition = provider.acquire({
      runId: runId('run-cancelled-clone'),
      signal: controller.signal,
      mode: 'read-only',
      workItemId: workId('cancelled-clone'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    });
    await cloneEntered;
    controller.abort(cancellation);

    await expect(acquisition).rejects.toBe(cancellation);
    expect(receivedSignal).toBe(controller.signal);
    const markers = await readdir(join(root, '.wake-workspace-ownership'));
    expect(markers.filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
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
      signal: new AbortController().signal,
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
      signal: new AbortController().signal,
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
      signal: new AbortController().signal,
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
        {
          command: nodeCommand(
            `require('node:fs').writeFileSync('.wake-prepare-result', '${outputName}')`,
          ),
          timeoutMs: 1_000,
        },
      );

      const lease = await provider.acquire({
        runId: runId(`run-${mode}`),
        signal: new AbortController().signal,
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
      signal: new AbortController().signal,
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
      {
        command: nodeCommand(
          "require('node:fs').appendFileSync('.wake-prepare-result', 'prepared')",
        ),
        timeoutMs: 1_000,
      },
    );
    const request = {
      signal: new AbortController().signal,
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
        command: nodeCommand(
          `process.stdout.write('discard-this-prefix${'x'.repeat(5_000)}'); process.stderr.write('${diagnostic}'); process.exit(7)`,
        ),
        timeoutMs: 1_000,
      },
    );

    const acquisition = provider.acquire({
      runId: runId('run-prepare-failure'),
      signal: new AbortController().signal,
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
      { command: nodeCommand('setTimeout(() => {}, 5_000)'), timeoutMs: 20 },
    );

    await expect(
      provider.acquire({
        runId: runId('run-prepare-timeout'),
        signal: new AbortController().signal,
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

  it('records ownership before cloning and retains a read-only workspace when the lease releases', async () => {
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
        if (args[0] !== 'clone') return;
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
      signal: new AbortController().signal,
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
    await expect(access(lease.path)).resolves.toBeUndefined();
    await expect(access(markerPath)).resolves.toBeUndefined();
  });

  it('reuses a read-only checkout, restores its requested revision, and prepares each lease', async () => {
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
      undefined,
      {
        command: nodeCommand("require('node:fs').appendFileSync('.prepared', 'x')"),
        timeoutMs: 1_000,
      },
    );
    const request = {
      signal: new AbortController().signal,
      mode: 'read-only' as const,
      workItemId: workId('read-only-reuse'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
        revision: 'deadbeef',
      },
    };

    const first = await provider.acquire({ ...request, runId: runId('run-read-only-first') });
    await first.release();
    const second = await provider.acquire({ ...request, runId: runId('run-read-only-second') });

    expect(second.path).toBe(first.path);
    expect(commands.filter(([command]) => command === 'clone')).toHaveLength(1);
    expect(commands.filter((command) => command.includes('fetch'))).toHaveLength(2);
    expect(commands.filter((command) => command.includes('reset'))).toHaveLength(2);
    await expect(readFile(join(second.path, '.prepared'), 'utf8')).resolves.toBe('xx');
    await second.release();
  });

  it('checks out the exact resource revision and preserves ignored dependency state on reuse', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const repository = join(root, 'repository');
    await execFileAsync('git', ['init', repository]);
    await writeFile(join(repository, 'tracked.txt'), 'first\n');
    await execFileAsync('git', ['-C', repository, 'add', 'tracked.txt']);
    await execFileAsync('git', [
      '-C',
      repository,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'first',
    ]);
    const firstRevision = (
      await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    await writeFile(join(repository, 'tracked.txt'), 'second\n');
    await execFileAsync('git', [
      '-C',
      repository,
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-am',
      'second',
    ]);
    const secondRevision = (
      await execFileAsync('git', ['-C', repository, 'rev-parse', 'HEAD'])
    ).stdout.trim();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => repository });
    const request = {
      signal: new AbortController().signal,
      mode: 'read-only' as const,
      workItemId: workId('exact-revision'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
        revision: firstRevision,
      },
    };
    const first = await provider.acquire({ ...request, runId: runId('run-exact-first') });
    await expect(readFile(join(first.path, 'tracked.txt'), 'utf8')).resolves.toBe('first\n');
    await mkdir(join(first.path, 'node_modules'), { recursive: true });
    await writeFile(join(first.path, 'node_modules', 'cached'), 'keep');
    await first.release();
    const second = await provider.acquire({
      ...request,
      runId: runId('run-exact-second'),
      repositoryResource: { ...request.repositoryResource, revision: secondRevision },
    });
    await expect(readFile(join(second.path, 'tracked.txt'), 'utf8')).resolves.toBe('second\n');
    await expect(readFile(join(second.path, 'node_modules', 'cached'), 'utf8')).resolves.toBe(
      'keep',
    );
    await second.release();
    const { revision: _revision, ...unpinnedResource } = request.repositoryResource;
    const unpinned = await provider.acquire({
      ...request,
      runId: runId('run-exact-unpinned'),
      repositoryResource: unpinnedResource,
    });
    await expect(readFile(join(unpinned.path, 'tracked.txt'), 'utf8')).resolves.toBe('second\n');
    await unpinned.release();
    await expect(
      provider.acquire({
        ...request,
        runId: runId('run-exact-unavailable'),
        repositoryResource: { ...request.repositoryResource, revision: 'missing-revision' },
      }),
    ).rejects.toThrow();
  });

  it('waits for a retained workspace lease and cancels while waiting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        if (args[0] === 'clone') await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
    );
    const request = {
      mode: 'read-only' as const,
      workItemId: workId('exclusive-read-only'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    };
    const first = await provider.acquire({
      ...request,
      runId: runId('run-exclusive-first'),
      signal: new AbortController().signal,
    });
    const controller = new AbortController();
    const waiting = provider.acquire({
      ...request,
      runId: runId('run-exclusive-second'),
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled while waiting'));
    await expect(waiting).rejects.toThrow('cancelled while waiting');
    await first.release();
  });

  it('serializes a competing acquisition until the existing lease releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-workspace-'));
    roots.push(root);
    let clones = 0;
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'https://github.com/atolis-hq/wake-test.git' },
      async (args) => {
        if (args[0] !== 'clone') return;
        clones += 1;
        await mkdir(join(args[2]!, '.git'), { recursive: true });
      },
    );
    const request = {
      mode: 'read-only' as const,
      workItemId: workId('serialized-read-only'),
      repositoryResource: {
        resourceId: resId('workspace-resource'),
        kind: resourceKind('issue'),
        externalKey: { adapter: 'github', key: 'atolis-hq/wake-test#1' },
        capabilities: [],
      },
    };
    const first = await provider.acquire({
      ...request,
      runId: runId('run-serialized-first'),
      signal: new AbortController().signal,
    });
    let acquired = false;
    const second = provider
      .acquire({
        ...request,
        runId: runId('run-serialized-second'),
        signal: new AbortController().signal,
      })
      .then((lease) => {
        acquired = true;
        return lease;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acquired).toBe(false);
    await first.release();
    const secondLease = await second;
    expect(secondLease.path).toBe(first.path);
    expect(clones).toBe(1);
    await secondLease.release();
  });
});
