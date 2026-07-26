import { execFile as nodeExecFile } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { createWakePaths } from '../../lib/paths.js';
import { branchNameForIssue } from '../../domain/branch-naming.js';
import type {
  WorkspaceBookkeepingResult,
  WorkspaceValidationResult,
} from '../../core/contracts.js';

const execFile = promisify(nodeExecFile);

// Re-exported for existing callers (this adapter's own use below, plus
// adapters/runner/stage-prompt.ts and tests) — the canonical definition now
// lives in domain/branch-naming.ts so core/ can use it without importing a
// concrete adapter.
export { branchNameForIssue };

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile('git', args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16,
  });

  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function gitExitCode(args: string[], cwd: string): Promise<number> {
  try {
    await execFile('git', args, {
      cwd,
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 16,
    });
    return 0;
  } catch (error) {
    const maybeExit = error as { code?: unknown };
    return typeof maybeExit.code === 'number' ? maybeExit.code : 1;
  }
}

export class WorkspaceValidationError extends Error {
  readonly failureSource = 'wake-workspace-validation';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
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

async function tryUpdateFromDefaultBranch(workspacePath: string): Promise<{
  mergeConflictDetected: boolean;
  upstreamChanges?: string;
}> {
  try {
    const { stdout: status } = await git(['status', '--porcelain'], workspacePath);
    if (status.length > 0) {
      return { mergeConflictDetected: false };
    }

    await git(['fetch', 'origin'], workspacePath);
    const defaultBranch = await detectDefaultBranch(workspacePath);

    const { stdout: count } = await git(
      ['rev-list', '--count', `HEAD..origin/${defaultBranch}`],
      workspacePath,
    );

    if (parseInt(count.trim(), 10) === 0) {
      return { mergeConflictDetected: false };
    }

    const { stdout: upstreamChanges } = await git(
      [
        'log',
        '--date=short',
        '--pretty=format:%h %ad %an <%ae>%n    %s',
        `HEAD..origin/${defaultBranch}`,
      ],
      workspacePath,
    );

    // Probe for conflicts without touching the index or worktree. A real merge
    // would need committer identity even with --no-commit on some Git versions.
    try {
      await git(['merge-tree', '--write-tree', 'HEAD', `origin/${defaultBranch}`], workspacePath);
      await git(
        [
          '-c',
          'user.email=wake@example.invalid',
          '-c',
          'user.name=Wake',
          'merge',
          '--no-edit',
          `origin/${defaultBranch}`,
        ],
        workspacePath,
      );
      return {
        mergeConflictDetected: false,
        ...(upstreamChanges.length === 0 ? {} : { upstreamChanges }),
      };
    } catch {
      return { mergeConflictDetected: true };
    }
  } catch {
    // Fetch or branch detection failed — leave workspace as-is, no conflict reported
    return { mergeConflictDetected: false };
  }
}

async function validateWorkspace(input: {
  workspacePath: string;
  repo: string;
  expectedBranch: string;
  expectedRemoteUrl: string;
  expectedBaseRef: string;
}): Promise<WorkspaceValidationResult> {
  await git(['fetch', 'origin'], input.workspacePath);
  const { stdout: actualRemoteUrl } = await git(
    ['remote', 'get-url', 'origin'],
    input.workspacePath,
  );
  const { stdout: actualBranch } = await git(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    input.workspacePath,
  );
  const { stdout: baseRevision } = await git(
    ['merge-base', 'HEAD', input.expectedBaseRef],
    input.workspacePath,
  );
  const { stdout: headRevision } = await git(['rev-parse', 'HEAD'], input.workspacePath);
  const { stdout: status } = await git(['status', '--porcelain'], input.workspacePath);
  const remoteExit = await gitExitCode(
    ['ls-remote', '--exit-code', 'origin', 'HEAD'],
    input.workspacePath,
  );

  const validation = {
    repo: input.repo,
    expectedBranch: input.expectedBranch,
    actualBranch,
    expectedRemoteUrl: input.expectedRemoteUrl,
    actualRemoteUrl,
    baseRevision,
    headRevision,
    clean: status.length === 0,
    remoteAvailable: remoteExit === 0,
  } satisfies WorkspaceValidationResult;

  const failures: string[] = [];
  if (actualRemoteUrl !== input.expectedRemoteUrl) {
    failures.push(`expected origin ${input.expectedRemoteUrl}, found ${actualRemoteUrl}`);
  }
  if (actualBranch !== input.expectedBranch) {
    failures.push(`expected branch ${input.expectedBranch}, found ${actualBranch}`);
  }
  if (!validation.clean) {
    failures.push('working tree has uncommitted or untracked changes');
  }
  if (!validation.remoteAvailable) {
    failures.push('origin remote is not available');
  }

  if (failures.length > 0) {
    throw new WorkspaceValidationError(`Workspace validation failed: ${failures.join('; ')}`);
  }

  return validation;
}

async function recordWorkspaceBookkeeping(
  workspacePath: string,
): Promise<WorkspaceBookkeepingResult> {
  const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath);
  const { stdout: headRevision } = await git(['rev-parse', 'HEAD'], workspacePath);
  const { stdout: diffSummary } = await git(['diff', '--stat', 'HEAD'], workspacePath);
  const { stdout: untracked } = await git(
    ['ls-files', '--others', '--exclude-standard'],
    workspacePath,
  );

  let hasUpstream = true;
  let count: number;
  let commits: string[];
  try {
    const { stdout: upstream } = await git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      workspacePath,
    );
    const { stdout: ahead } = await git(
      ['rev-list', '--count', `${upstream}..HEAD`],
      workspacePath,
    );
    count = parseInt(ahead, 10);
    const { stdout: commitLog } = await git(
      ['log', '--pretty=format:%h %s', `${upstream}..HEAD`],
      workspacePath,
    );
    commits = commitLog.length === 0 ? [] : commitLog.split('\n');
  } catch {
    hasUpstream = false;
    const { stdout: commitLog } = await git(['log', '--pretty=format:%h %s'], workspacePath);
    commits = commitLog.length === 0 ? [] : commitLog.split('\n');
    count = commits.length;
  }

  return {
    branch,
    headRevision,
    diffSummary,
    untrackedFiles: untracked.length === 0 ? [] : untracked.split('\n'),
    unpushedCommits: {
      hasUpstream,
      count,
      commits,
    },
  };
}

export function createGitWorkspaceManager(options: {
  wakeRoot: string;
  remoteUrlForRepo?: (repo: string) => string;
}) {
  const paths = createWakePaths(options.wakeRoot);
  const remoteUrlForRepo = options.remoteUrlForRepo ?? defaultRemoteUrlForRepo;

  async function ensureCanonicalClone(
    repo: string,
  ): Promise<{ repoPath: string; defaultBranch: string }> {
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
      workId,
      repo,
      issueNumber,
    }: {
      workId: string;
      repo: string;
      issueNumber: number;
    }): Promise<{
      workspacePath: string;
      mergeConflictDetected: boolean;
      upstreamChanges?: string;
      validation?: WorkspaceValidationResult;
    }> {
      // The workspace is keyed by work item; `repo` still drives the clone and
      // `issueNumber` still names the branch, which stays human-readable and
      // provider-facing (spec D2).
      const workspacePath = paths.workspaceDir(workId);
      if (await pathExists(workspacePath)) {
        const updateResult = await tryUpdateFromDefaultBranch(workspacePath);
        const defaultBranch = await detectDefaultBranch(workspacePath);
        const validation = await validateWorkspace({
          workspacePath,
          repo,
          expectedBranch: branchNameForIssue(issueNumber),
          expectedRemoteUrl: remoteUrlForRepo(repo),
          expectedBaseRef: `origin/${defaultBranch}`,
        });
        return { workspacePath, ...updateResult, validation };
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

      const validation = await validateWorkspace({
        workspacePath,
        repo,
        expectedBranch: branch,
        expectedRemoteUrl: remoteUrl,
        expectedBaseRef: `origin/${defaultBranch}`,
      });

      return { workspacePath, mergeConflictDetected: false, validation };
    },
    async prepareReadOnlyClone({
      repo,
    }: {
      repo: string;
    }): Promise<{ workspacePath: string; validation?: WorkspaceValidationResult }> {
      // Refine only reads the issue and, at most, the canonical clone -
      // it never gets a per-issue branch/workspace of its own (only
      // 'implement' pays that cost).
      const { repoPath } = await ensureCanonicalClone(repo);
      const defaultBranch = await detectDefaultBranch(repoPath);
      const validation = await validateWorkspace({
        workspacePath: repoPath,
        repo,
        expectedBranch: defaultBranch,
        expectedRemoteUrl: remoteUrlForRepo(repo),
        expectedBaseRef: `origin/${defaultBranch}`,
      });
      return { workspacePath: repoPath, validation };
    },
    async recordWorkspaceBookkeeping({
      workspacePath,
    }: {
      workspacePath: string;
    }): Promise<WorkspaceBookkeepingResult> {
      return recordWorkspaceBookkeeping(workspacePath);
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
