import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export function createFakeWorkspaceManager(root: string) {
  return {
    async prepareWorkspace({
      repo,
      issueNumber,
    }: {
      repo: string;
      issueNumber: number;
    }) {
      const workspacePath = join(root, repo.replace(/[\\/]/g, '__'), String(issueNumber));
      await mkdir(workspacePath, { recursive: true });
      return { workspacePath };
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
