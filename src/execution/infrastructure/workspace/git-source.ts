import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepositoryAssignment } from '../../contracts/repository-assignment.js';
import type { RepositoryCloneResolver } from './git-workspace.js';

const exec = promisify(execFile);

/** Fetching into an empty repository proves availability in the selected source. */
export async function resolveGitSource(
  resolver: RepositoryCloneResolver,
  request: Omit<RepositoryAssignment, 'sourceRevision'> & {
    readonly sourceRevision?: string | undefined;
  },
): Promise<RepositoryAssignment> {
  const signal = AbortSignal.timeout(60_000);
  const locator = await resolver.cloneLocator(request.resourceId, signal);
  const path = await mkdtemp(join(tmpdir(), 'wake-source-'));
  try {
    await exec('git', ['init', '--bare', path], { signal });
    await exec(
      'git',
      [
        '-C',
        path,
        'fetch',
        '--no-tags',
        '--',
        locator,
        request.sourceRevision ?? request.sourceRef,
      ],
      { signal },
    );
    const revision = (
      await exec('git', ['-C', path, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { signal })
    ).stdout.trim();
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision) ||
      (request.sourceRevision !== undefined && revision !== request.sourceRevision)
    )
      throw new Error('Source did not resolve to the requested commit');
    return { ...request, sourceRevision: revision };
  } catch (error) {
    throw new Error(
      `Repository ${request.resourceId} source ${request.sourceRevision ?? request.sourceRef} is unavailable; publish the source to the selected repository`,
      { cause: error },
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
