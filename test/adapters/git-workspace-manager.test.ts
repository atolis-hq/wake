import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  branchNameForIssue,
  buildWorkspaceCloneArgs,
  createGitWorkspaceManager,
} from '../../src/adapters/git/git-workspace-manager.js';

const execFile = promisify(nodeExecFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFile('git', args, { cwd, env: process.env });
}

describe('git workspace manager', () => {
  let root: string;
  let remotePath: string;

  async function createRemote(defaultBranch = 'main'): Promise<string> {
    const remotePath = join(root, `${defaultBranch}.git`);
    const seedPath = join(root, `seed-${defaultBranch}`);
    await git(['init', `--initial-branch=${defaultBranch}`, seedPath], root);
    await writeFile(join(seedPath, 'README.md'), '# seed\n', 'utf8');
    await git(['-C', seedPath, 'config', 'user.email', 'wake@example.test'], root);
    await git(['-C', seedPath, 'config', 'user.name', 'Wake Test'], root);
    await git(['-C', seedPath, 'config', 'commit.gpgsign', 'false'], root);
    await git(['-C', seedPath, 'add', 'README.md'], root);
    await git(['-C', seedPath, 'commit', '-m', 'seed'], root);

    await git(['clone', '--bare', seedPath, remotePath], root);
    await git(['-C', seedPath, 'remote', 'add', 'origin', remotePath], root);
    await git(['-C', seedPath, 'push', 'origin', defaultBranch], root);

    return remotePath;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-git-workspace-'));
    remotePath = await createRemote();
  });

  afterEach(async () => {
    // On Windows, a just-exited git subprocess (or AV/indexer) can briefly hold a
    // handle on files it touched inside the cloned workspaces; a bare rm races
    // that and fails EBUSY/EPERM. maxRetries/retryDelay retry with backoff
    // instead of failing the test on unrelated teardown flakiness.
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('prepares a workspace checked out on a wake/issue branch from main', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareWorkspace({
      repo: 'acme/example',
      issueNumber: 42,
    });

    const readme = await readFile(join(workspacePath, 'README.md'), 'utf8');
    expect(readme).toContain('# seed');

    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      env: process.env,
    });
    expect(stdout.trim()).toBe(branchNameForIssue(42));

    const { stdout: remoteUrl } = await execFile('git', ['remote', 'get-url', 'origin'], {
      cwd: workspacePath,
      env: process.env,
    });
    expect(remoteUrl.trim()).toBe(remotePath);
  // git subprocess work (clone/fetch/reset) is routinely slower than vitest's
  // default 5s timeout on Windows (AV/indexer contention); give these room.
  }, 20_000);

  it('resets an existing canonical clone to the latest main on re-prepare', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    await manager.prepareWorkspace({ repo: 'acme/example', issueNumber: 1 });

    const seedPath = join(root, 'seed-main');
    await writeFile(join(seedPath, 'README.md'), '# updated\n', 'utf8');
    await git(['-C', seedPath, 'add', 'README.md'], root);
    await git(['-C', seedPath, 'commit', '-m', 'update'], root);
    await git(['-C', seedPath, 'push', 'origin', 'main'], root);

    const { workspacePath } = await manager.prepareWorkspace({
      repo: 'acme/example',
      issueNumber: 2,
    });

    const readme = await readFile(join(workspacePath, 'README.md'), 'utf8');
    expect(readme).toContain('# updated');
  }, 20_000);

  it('prepares workspaces from a non-main default branch', async () => {
    remotePath = await createRemote('trunk');
    const wakeRoot = join(root, '.wake-trunk');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareWorkspace({
      repo: 'acme/trunk-example',
      issueNumber: 77,
    });

    const readme = await readFile(join(workspacePath, 'README.md'), 'utf8');
    expect(readme).toContain('# seed');

    const { stdout: branch } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      env: process.env,
    });
    expect(branch.trim()).toBe(branchNameForIssue(77));

    const { workspacePath: readOnlyPath } = await manager.prepareReadOnlyClone({
      repo: 'acme/trunk-example',
    });
    const { stdout: readOnlyBranch } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: readOnlyPath,
      env: process.env,
    });
    expect(readOnlyBranch.trim()).toBe('trunk');
  }, 20_000);

  it('prepares a read-only canonical clone for refine without a per-issue branch', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareReadOnlyClone({ repo: 'acme/example' });

    const readme = await readFile(join(workspacePath, 'README.md'), 'utf8');
    expect(readme).toContain('# seed');

    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      env: process.env,
    });
    expect(stdout.trim()).toBe('main');
  }, 20_000);

  it('reuses an existing per-issue workspace and recreates it only when missing', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const first = await manager.prepareWorkspace({
      repo: 'acme/example',
      issueNumber: 42,
    });

    await writeFile(join(first.workspacePath, 'local-only.txt'), 'keep me\n', 'utf8');

    const second = await manager.prepareWorkspace({
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(second.workspacePath).toBe(first.workspacePath);
    await expect(access(join(second.workspacePath, 'local-only.txt'))).resolves.toBeUndefined();

    await manager.cleanupWorkspace({ workspacePath: second.workspacePath });
    await expect(access(second.workspacePath)).rejects.toThrow();

    const third = await manager.prepareWorkspace({
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(third.workspacePath).toBe(first.workspacePath);
    const readme = await readFile(join(third.workspacePath, 'README.md'), 'utf8');
    expect(readme).toContain('# seed');
    await expect(access(join(third.workspacePath, 'local-only.txt'))).rejects.toThrow();
  }, 20_000);

  it('uses a non-hardlink local clone when creating a missing workspace', () => {
    expect(
      buildWorkspaceCloneArgs({
        sourceRepoPath: '/wake/repos/acme__example',
        workspacePath: '/wake/workspaces/acme__example/42',
        defaultBranch: 'main',
      }),
    ).toEqual([
      'clone',
      '--no-local',
      '--branch',
      'main',
      '/wake/repos/acme__example',
      '/wake/workspaces/acme__example/42',
    ]);
  });
});
