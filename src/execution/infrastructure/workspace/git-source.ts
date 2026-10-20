import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  RepositorySourceError,
  type RepositoryAssignment,
} from '../../contracts/repository-assignment.js';
import { RepositorySourceFailure } from '../../contracts/vocabulary.js';
import type { RepositoryCloneResolver } from '../../contracts/workspace.js';

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
    if (
      request.sourceRevision === undefined &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(request.sourceRef)
    )
      await assertRemoteRef(locator, request, signal);
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
    if (error instanceof RepositorySourceError) throw error;
    throw new RepositorySourceError(
      RepositorySourceFailure.FetchFailed,
      `Repository ${request.resourceId} source ${request.sourceRevision ?? request.sourceRef} is unavailable: fetch failed; verify connectivity and permissions, and publish the source to the selected repository if missing`,
      { cause: error },
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function assertRemoteRef(
  locator: string,
  request: { readonly resourceId: string; readonly sourceRef: string },
  signal: AbortSignal,
): Promise<void> {
  try {
    await exec('git', ['ls-remote', '--exit-code', '--', locator, request.sourceRef], { signal });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 2)
      throw new RepositorySourceError(
        RepositorySourceFailure.RefUnavailable,
        `Repository ${request.resourceId} source ${request.sourceRef} is unavailable; remote ref is missing`,
        { cause: error },
      );
    throw error;
  }
}
