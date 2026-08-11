import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceProvider, WorkspaceRequest } from '../../contracts/workspace.js';

const exec = promisify(execFile);

export interface RepositoryCloneResolver {
  cloneLocator(resourceId: string): Promise<string>;
}

export type GitRunner = (arguments_: readonly string[]) => Promise<void>;

export class GitWorkspaceProvider implements WorkspaceProvider {
  constructor(
    private readonly root: string,
    private readonly resolver: RepositoryCloneResolver,
    private readonly git: GitRunner = async (arguments_) => {
      await exec('git', arguments_);
    },
  ) {}

  async acquire(request: WorkspaceRequest) {
    const locator = await this.resolver.cloneLocator(request.repositoryResource.resourceId);
    const name = `${request.workItemId}-${slug(locator)}`;
    const path = resolve(this.root, name);
    const markerPath = join(this.root, '.wake-workspace-ownership', `${name}.json`);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify({
        runId: request.runId,
        workItemId: request.workItemId,
        repositoryResourceId: request.repositoryResource.resourceId,
        mode: request.mode,
        workspaceId: name,
        path,
      }),
      'utf8',
    );
    if (!(await exists(join(path, '.git')))) {
      await mkdir(dirname(path), { recursive: true });
      await this.git(['clone', locator, path]);
    }
    return {
      workspaceId: name,
      path,
      mode: request.mode,
      release: async () => {
        await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await rm(markerPath, { force: true });
      },
    };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
