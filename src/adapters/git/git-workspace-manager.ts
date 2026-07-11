import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

async function detectDefaultBranch(repoPath: string): Promise<string> {
  await git(['remote', 'set-head', 'origin', '--auto'], repoPath);

  const { stdout } = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath);
  const defaultBranch = stdout.replace(/^origin\//, '');

  if (defaultBranch.length === 0) {
    throw new Error(`Unable to detect default branch for ${repoPath}`);
  }

  return defaultBranch;
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

export function buildWorkspaceCloneArgs(input: {
  sourceRepoPath: string;
  workspacePath: string;
  defaultBranch: string;
}): string[] {
  return [
    'clone',
    '--no-local',
    '--branch',
    input.defaultBranch,
    input.sourceRepoPath,
    input.workspacePath,
  ];
}

async function tryUpdateFromDefaultBranch(workspacePath: string): Promise<boolean> {
  try {
    const { stdout: status } = await git(['status', '--porcelain'], workspacePath);
    if (status.length > 0) {
      return false;
    }

    await git(['fetch', 'origin'], workspacePath);
    const defaultBranch = await detectDefaultBranch(workspacePath);

    const { stdout: count } = await git(
      ['rev-list', '--count', `HEAD..origin/${defaultBranch}`],
      workspacePath,
    );

    if (parseInt(count.trim(), 10) === 0) {
      return false;
    }

    try {
      // Supply fallback identity so merge commits succeed in environments where
      // git user.email/user.name is not configured globally (e.g. CI containers).
      await git(
        ['-c', 'user.email=wake@merge.local', '-c', 'user.name=Wake', 'merge', '--no-edit', `origin/${defaultBranch}`],
        workspacePath,
      );
      return false;
    } catch {
      try {
        await git(['merge', '--abort'], workspacePath);
      } catch {
        // Merge abort failed (e.g. no merge in progress) — ignore
      }
      return true;
    }
  } catch {
    // Fetch or branch detection failed — leave workspace as-is, no conflict reported
    return false;
  }
}

export function createGitWorkspaceManager(options: {
  wakeRoot: string;
  remoteUrlForRepo?: (repo: string) => string;
}) {
  const paths = createWakePaths(options.wakeRoot);
  const remoteUrlForRepo = options.remoteUrlForRepo ?? defaultRemoteUrlForRepo;

  async function ensureCanonicalClone(repo: string): Promise<{ repoPath: string; defaultBranch: string }> {
    const repoPath = paths.repoRoot(repo);
    const remoteUrl = remoteUrlForRepo(repo);

    if (await pathExists(repoPath)) {
      // The canonical clone is only ever touched by one tick at a time, so an
      // index.lock found here can't be a live concurrent writer - it's a leftover
      // from a process that was killed mid-git-operation (e.g. a container
      // restart). Left in place it wedges every future tick on this repo with
      // "Unable to create index.lock: File exists", so clear it defensively
      // before running any git command against the clone.
      await rm(join(repoPath, '.git', 'index.lock'), { force: true });
      await git(['fetch', 'origin'], repoPath);
      const defaultBranch = await detectDefaultBranch(repoPath);
      await git(['checkout', defaultBranch], repoPath);
      await git(['reset', '--hard', `origin/${defaultBranch}`], repoPath);
      await git(['clean', '-fdx'], repoPath);
      return { repoPath, defaultBranch };
    } else {
      await mkdir(dirname(repoPath), { recursive: true });
      await git(['clone', remoteUrl, repoPath], dirname(repoPath));
      const defaultBranch = await detectDefaultBranch(repoPath);
      return { repoPath, defaultBranch };
    }
  }

  return {
    async prepareWorkspace({
      repo,
      issueNumber,
    }: {
      repo: string;
      issueNumber: number;
    }): Promise<{ workspacePath: string; mergeConflictDetected: boolean }> {
      const workspacePath = paths.workspaceDir(repo, issueNumber);
      if (await pathExists(workspacePath)) {
        const mergeConflictDetected = await tryUpdateFromDefaultBranch(workspacePath);
        return { workspacePath, mergeConflictDetected };
      }

      const { repoPath, defaultBranch } = await ensureCanonicalClone(repo);
      const remoteUrl = remoteUrlForRepo(repo);

      await mkdir(dirname(workspacePath), { recursive: true });
      await git(
        buildWorkspaceCloneArgs({
          sourceRepoPath: repoPath,
          workspacePath,
          defaultBranch,
        }),
        dirname(workspacePath),
      );

      const branch = branchNameForIssue(issueNumber);
      await git(['remote', 'set-url', 'origin', remoteUrl], workspacePath);
      await git(['checkout', '-B', branch], workspacePath);

      return { workspacePath, mergeConflictDetected: false };
    },
    async prepareReadOnlyClone({ repo }: { repo: string }): Promise<{ workspacePath: string }> {
      // Refine only reads the issue and, at most, the canonical clone -
      // it never gets a per-issue branch/workspace of its own (only
      // 'implement' pays that cost).
      const { repoPath } = await ensureCanonicalClone(repo);
      return { workspacePath: repoPath };
    },
    async cleanupWorkspace({ workspacePath }: { workspacePath: string }): Promise<void> {
      // On Windows, a just-exited git subprocess (or AV/indexer) can hold a brief
      // handle on files it touched; a bare rm races that and fails EBUSY/EPERM.
      // maxRetries/retryDelay make fs.rm retry with backoff instead of throwing.
      await rm(workspacePath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    },
  };
}
