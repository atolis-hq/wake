import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function createFakeWorkspaceManager(root: string) {
  return {
    async prepareWorkspace({
      workId,
    }: {
      workId: string;
      repo: string;
      issueNumber: number;
    }) {
      // Keyed on the work id, symmetrically with the real git-backed manager.
      const workspacePath = join(root, workId);
      await mkdir(workspacePath, { recursive: true });
      return { workspacePath, mergeConflictDetected: false };
    },
    async prepareReadOnlyClone({ repo }: { repo: string }) {
      const workspacePath = join(root, repo.replace(/[\\/]/g, '__'), 'canonical');
      await mkdir(workspacePath, { recursive: true });
      return { workspacePath };
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
