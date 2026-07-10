import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { createWakePaths } from '../../lib/paths.js';

const execFile = promisify(nodeExecFile);

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile('git', args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });

  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function branchNameForIssue(issueNumber: number): string {
  return `wake/issue-${issueNumber}`;
}

export function defaultRemoteUrlForRepo(repo: string): string {
  return `https://github.com/${repo}.git`;
}

export function createGitWorkspaceManager(options: {
  wakeRoot: string;
  remoteUrlForRepo?: (repo: string) => string;
}) {
  const paths = createWakePaths(options.wakeRoot);
  const remoteUrlForRepo = options.remoteUrlForRepo ?? defaultRemoteUrlForRepo;

  async function ensureCanonicalClone(repo: string): Promise<string> {
    const repoPath = paths.repoRoot(repo);
    const remoteUrl = remoteUrlForRepo(repo);

    if (await pathExists(repoPath)) {
      await git(['fetch', 'origin'], repoPath);
      await git(['checkout', 'main'], repoPath);
      await git(['reset', '--hard', 'origin/main'], repoPath);
      await git(['clean', '-fdx'], repoPath);
    } else {
      await mkdir(dirname(repoPath), { recursive: true });
      await git(['clone', remoteUrl, repoPath], dirname(repoPath));
    }

    return repoPath;
  }

  return {
    async prepareWorkspace({
      repo,
      issueNumber,
    }: {
      repo: string;
      issueNumber: number;
    }): Promise<{ workspacePath: string }> {
      const workspacePath = paths.workspaceDir(repo, issueNumber);
      if (await pathExists(workspacePath)) {
        return { workspacePath };
      }

      const repoPath = await ensureCanonicalClone(repo);
      const remoteUrl = remoteUrlForRepo(repo);

      await mkdir(dirname(workspacePath), { recursive: true });
      await git(['clone', '--local', '--branch', 'main', repoPath, workspacePath], dirname(workspacePath));

      const branch = branchNameForIssue(issueNumber);
      await git(['remote', 'set-url', 'origin', remoteUrl], workspacePath);
      await git(['checkout', '-B', branch], workspacePath);

      return { workspacePath };
    },
    async prepareReadOnlyClone({ repo }: { repo: string }): Promise<{ workspacePath: string }> {
      // Refine only reads the issue and, at most, the canonical clone -
      // it never gets a per-issue branch/workspace of its own (only
      // 'implement' pays that cost).
      const repoPath = await ensureCanonicalClone(repo);
      return { workspacePath: repoPath };
    },
    async cleanupWorkspace({ workspacePath }: { workspacePath: string }): Promise<void> {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}
