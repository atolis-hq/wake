import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  WorkspaceBookkeepingResult,
  WorkspaceValidationResult,
} from '../../core/contracts.js';

export class FakeWorkspaceValidationError extends Error {
  readonly failureSource = 'wake-workspace-validation';

  constructor(message: string) {
    super(message);
    this.name = 'FakeWorkspaceValidationError';
  }
}

export function createFakeWorkspaceManager(
  root: string,
  options: {
    failValidation?: boolean;
    failBookkeeping?: boolean;
  } = {},
) {
  function validation(input: {
    repo: string;
    branch: string;
    remoteUrl: string;
  }): WorkspaceValidationResult {
    if (options.failValidation === true) {
      throw new FakeWorkspaceValidationError('fake workspace validation failed');
    }

    return {
      repo: input.repo,
      expectedBranch: input.branch,
      actualBranch: input.branch,
      expectedRemoteUrl: input.remoteUrl,
      actualRemoteUrl: input.remoteUrl,
      baseRevision: 'fake-base',
      headRevision: 'fake-head',
      clean: true,
      remoteAvailable: true,
    };
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
    }) {
      // Keyed on the work id, symmetrically with the real git-backed manager.
      const workspacePath = join(root, workId);
      await mkdir(workspacePath, { recursive: true });
      return {
        workspacePath,
        mergeConflictDetected: false,
        validation: validation({
          repo,
          branch: `wake/issue-${issueNumber}`,
          remoteUrl: `https://github.com/${repo}.git`,
        }),
      };
    },
    async prepareReadOnlyClone({ repo }: { repo: string }) {
      const workspacePath = join(root, repo.replace(/[\\/]/g, '__'), 'canonical');
      await mkdir(workspacePath, { recursive: true });
      return {
        workspacePath,
        validation: validation({
          repo,
          branch: 'main',
          remoteUrl: `https://github.com/${repo}.git`,
        }),
      };
    },
    async recordWorkspaceBookkeeping(): Promise<WorkspaceBookkeepingResult> {
      if (options.failBookkeeping === true) {
        throw new Error('fake workspace bookkeeping failed');
      }

      return {
        branch: 'wake/issue-fake',
        headRevision: 'fake-head-after-run',
        diffSummary: '',
        untrackedFiles: [],
        unpushedCommits: {
          hasUpstream: false,
          count: 0,
          commits: [],
        },
      };
    },
    async cleanupWorkspace({ workspacePath }: { workspacePath: string }) {
      // Retry on Windows EBUSY/EPERM (AV/indexer holding a brief handle) to
      // match the real git-backed workspace manager's cleanup behavior.
      await rm(workspacePath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    },
  };
}
