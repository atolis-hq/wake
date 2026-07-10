import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  branchNameForIssue,
  createGitWorkspaceManager,
} from '../../src/adapters/git/git-workspace-manager.js';

const execFile = promisify(nodeExecFile);

async function git(args: string[], cwd: string): Promise<void> {
  await execFile('git', args, { cwd, env: process.env });
}

describe('git workspace manager', () => {
  let root: string;
  let remotePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-git-workspace-'));
    remotePath = join(root, 'remote.git');

    const seedPath = join(root, 'seed');
    await git(['init', '--initial-branch=main', seedPath], root);
    await writeFile(join(seedPath, 'README.md'), '# seed\n', 'utf8');
    await git(['-C', seedPath, 'config', 'user.email', 'wake@example.test'], root);
    await git(['-C', seedPath, 'config', 'user.name', 'Wake Test'], root);
    await git(['-C', seedPath, 'config', 'commit.gpgsign', 'false'], root);
    await git(['-C', seedPath, 'add', 'README.md'], root);
    await git(['-C', seedPath, 'commit', '-m', 'seed'], root);

    await git(['clone', '--bare', seedPath, remotePath], root);
    await git(['-C', seedPath, 'remote', 'add', 'origin', remotePath], root);
    await git(['-C', seedPath, 'push', 'origin', 'main'], root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
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
  });

  it('resets an existing canonical clone to the latest main on re-prepare', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    await manager.prepareWorkspace({ repo: 'acme/example', issueNumber: 1 });

    const seedPath = join(root, 'seed');
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
  });

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
  });

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
  });
});
