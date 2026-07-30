import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceProvider, WorkspaceRequest } from '../../contracts/workspace.js';

export interface RepositoryCloneResolver {
  cloneLocator(resourceId: string): Promise<string>;
}

export class GitWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly root: string,
    private readonly resolver: RepositoryCloneResolver,
  ) {}

  async acquire(request: WorkspaceRequest) {
    const locator = await this.resolver.cloneLocator(request.repositoryResource.resourceId);
    const name = `${request.workItemId}-${slug(locator)}`;
    const path = join(this.root, name);
    await mkdir(path, { recursive: true });
    return {
      workspaceId: name,
      path,
      mode: request.mode,
      release: async () => rm(path, { recursive: true, force: true }),
    };
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
