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
    async cleanupWorkspace({ workspacePath }: { workspacePath: string }) {
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}
