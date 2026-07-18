import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * A stable, ULID-shaped work id per issue number. The workspace is keyed by
 * work id now, so tests that must land in the *same* workspace pass the same
 * id; the issue number only reaches the branch name. Real ids come from
 * createWorkId().
 */
function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

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
    // Best-effort, hard-capped teardown so it can never fail or time out the
    // suite. On Windows a just-exited git subprocess (or an AV scanner / search
    // indexer) can keep handles on files inside the clones, and because the
    // workspace manager clones with --no-local the object stores are fully
    // copied rather than hardlinked, so a recursive rm racing those handles
    // crawls (it does not reject — it retries busy entries indefinitely-ish).
    // Race it against a cap and abandon it if it hasn't finished: the root
    // lives under the OS temp dir and is reclaimed regardless, and any leftover
    // rm keeps running harmlessly against the old (now-unused) path. CI (Linux)
    // rm's in milliseconds and never hits the cap; this only bounds the Windows
    // pathology.
    const cleanup = rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 250,
    }).catch(() => {});
    await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 8_000))]);
  });

  it('prepares a workspace checked out on a wake/issue branch from main', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareWorkspace({
      workId: workId(42),
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

    await manager.prepareWorkspace({ workId: workId(1), repo: 'acme/example', issueNumber: 1 });

    const seedPath = join(root, 'seed-main');
    await writeFile(join(seedPath, 'README.md'), '# updated\n', 'utf8');
    await git(['-C', seedPath, 'add', 'README.md'], root);
    await git(['-C', seedPath, 'commit', '-m', 'update'], root);
    await git(['-C', seedPath, 'push', 'origin', 'main'], root);

    const { workspacePath } = await manager.prepareWorkspace({
      workId: workId(2),
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
      workId: workId(77),
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
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    await writeFile(join(first.workspacePath, 'local-only.txt'), 'keep me\n', 'utf8');

    const second = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(second.workspacePath).toBe(first.workspacePath);
    await expect(access(join(second.workspacePath, 'local-only.txt'))).resolves.toBeUndefined();

    await manager.cleanupWorkspace({ workspacePath: second.workspacePath });
    await expect(access(second.workspacePath)).rejects.toThrow();

    const third = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(third.workspacePath).toBe(first.workspacePath);
    const readme = await readFile(join(third.workspacePath, 'README.md'), 'utf8');
    expect(readme).toContain('# seed');
    await expect(access(join(third.workspacePath, 'local-only.txt'))).rejects.toThrow();
  }, 20_000);

  it('clears a stale index.lock on the canonical clone before re-preparing', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath: firstWorkspace } = await manager.prepareWorkspace({
      workId: workId(1),
      repo: 'acme/example',
      issueNumber: 1,
    });
    const repoPath = join(wakeRoot, 'repos', 'acme__example');

    // Simulate a process that was killed mid-git-operation on the canonical clone.
    await mkdir(join(repoPath, '.git'), { recursive: true });
    await writeFile(join(repoPath, '.git', 'index.lock'), '', 'utf8');

    const { workspacePath: secondWorkspace } = await manager.prepareWorkspace({
      workId: workId(2),
      repo: 'acme/example',
      issueNumber: 2,
    });

    expect(secondWorkspace).not.toBe(firstWorkspace);
    const readme = await readFile(join(secondWorkspace, 'README.md'), 'utf8');
    expect(readme).toContain('# seed');
  }, 20_000);

  it('returns mergeConflictDetected: false for a freshly created workspace', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { mergeConflictDetected } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(mergeConflictDetected).toBe(false);
  }, 20_000);

  it('pulls latest default-branch changes into an existing clean workspace', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    // Push a new file to remote main (no conflict)
    const seedPath = join(root, 'seed-main');
    await writeFile(join(seedPath, 'newfile.txt'), 'new content\n', 'utf8');
    await git(['-C', seedPath, 'add', 'newfile.txt'], root);
    await git(['-C', seedPath, 'commit', '-m', 'add newfile'], root);
    await git(['-C', seedPath, 'push', 'origin', 'main'], root);

    const { mergeConflictDetected, upstreamChanges } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(mergeConflictDetected).toBe(false);
    expect(upstreamChanges).toContain('add newfile');
    expect(upstreamChanges).toContain('Wake Test <wake@example.test>');
    const newFile = await readFile(join(workspacePath, 'newfile.txt'), 'utf8');
    expect(newFile).toBe('new content\n');
  }, 20_000);

  it('skips merge update when workspace has pending changes', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    // Push a new file to remote main
    const seedPath = join(root, 'seed-main');
    await writeFile(join(seedPath, 'newfile.txt'), 'new content\n', 'utf8');
    await git(['-C', seedPath, 'add', 'newfile.txt'], root);
    await git(['-C', seedPath, 'commit', '-m', 'add newfile'], root);
    await git(['-C', seedPath, 'push', 'origin', 'main'], root);

    // Introduce a pending (untracked) change in the workspace
    await writeFile(join(workspacePath, 'pending.txt'), 'local work\n', 'utf8');

    const { mergeConflictDetected } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(mergeConflictDetected).toBe(false);
    // Pending file is preserved (merge was skipped)
    await expect(access(join(workspacePath, 'pending.txt'))).resolves.toBeUndefined();
    // Upstream file was NOT merged (merge was skipped)
    await expect(access(join(workspacePath, 'newfile.txt'))).rejects.toThrow();
  }, 20_000);

  it('detects merge conflict and leaves workspace in a clean state', async () => {
    const wakeRoot = join(root, '.wake');
    const manager = createGitWorkspaceManager({
      wakeRoot,
      remoteUrlForRepo: () => remotePath,
    });

    const { workspacePath } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    // Commit a conflicting change in the workspace branch
    await writeFile(join(workspacePath, 'README.md'), '# workspace version\n', 'utf8');
    await git(['-C', workspacePath, 'add', 'README.md'], root);
    await git(['-C', workspacePath, '-c', 'user.email=test@test.local', '-c', 'user.name=Test', 'commit', '-m', 'workspace change'], root);

    // Push a conflicting change to remote main (same file, different content)
    const seedPath = join(root, 'seed-main');
    await writeFile(join(seedPath, 'README.md'), '# remote version\n', 'utf8');
    await git(['-C', seedPath, 'add', 'README.md'], root);
    await git(['-C', seedPath, 'commit', '-m', 'remote change'], root);
    await git(['-C', seedPath, 'push', 'origin', 'main'], root);

    const { mergeConflictDetected } = await manager.prepareWorkspace({
      workId: workId(42),
      repo: 'acme/example',
      issueNumber: 42,
    });

    expect(mergeConflictDetected).toBe(true);

    // Workspace must not be left in a MERGING state
    const { stdout: statusOutput } = await execFile('git', ['status', '--porcelain'], {
      cwd: workspacePath,
      env: process.env,
    });
    expect(statusOutput.trim()).toBe('');
  }, 20_000);

  it('uses a non-hardlink local clone when creating a missing workspace', () => {
    expect(
      buildWorkspaceCloneArgs({
        sourceRepoPath: '/wake/repos/acme__example',
        workspacePath: '/wake/workspaces/work-01JZ0000000000000000000042',
        defaultBranch: 'main',
      }),
    ).toEqual([
      'clone',
      '--no-local',
      '--branch',
      'main',
      '/wake/repos/acme__example',
      '/wake/workspaces/work-01JZ0000000000000000000042',
    ]);
  });
});
