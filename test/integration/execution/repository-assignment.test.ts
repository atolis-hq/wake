import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { GitWorkspaceProvider, resolveGitSource, runId } from '../../../src/execution/index.js';
import { BuiltInResourceKind } from '../../../src/resources/index.js';
import { resId, workId } from '../../support/identities.js';
import { workspaceLocks } from '../../support/workspace-locks.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(path: string, ...args: string[]) {
  return (await exec('git', ['-C', path, ...args])).stdout.trim();
}

async function repository(root: string, name: string) {
  const path = join(root, name);
  await exec('git', ['init', '-b', 'main', path]);
  await git(path, 'config', 'user.name', 'Fixture');
  await git(path, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(path, 'file'), name);
  await git(path, 'add', '.');
  await git(path, 'commit', '-m', name);
  return path;
}

it('pins two repository sources, survives branch movement and restart, and preserves dirty implementation work (DC-11, DC-21)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-assignment-'));
  roots.push(root);
  const repositories = { a: await repository(root, 'a'), b: await repository(root, 'b') };
  const resolver = {
    cloneLocator: async (id: string) => repositories[id === resId('a') ? 'a' : 'b'],
  };
  for (const id of ['a', 'b'] as const) {
    const sourceRef = id === 'b' ? 'unmerged-upstream' : 'main';
    if (id === 'b') {
      await git(repositories[id], 'switch', '-c', sourceRef);
      await writeFile(join(repositories[id], 'upstream'), 'unmerged change');
      await git(repositories[id], 'add', '.');
      await git(repositories[id], 'commit', '-m', 'unmerged upstream change');
    }
    const assignment = await resolveGitSource(resolver, {
      resourceId: resId(id),
      sourceRef,
      pullRequestBase: 'integration',
    });
    await writeFile(join(repositories[id], 'file'), 'moved');
    await git(repositories[id], 'commit', '-am', 'move main');
    const request = {
      runId: runId('run-' + id),
      signal: new AbortController().signal,
      workItemId: workId('child-' + id),
      mode: 'branch' as const,
      assignment,
      repositoryResource: {
        resourceId: resId(id),
        kind: BuiltInResourceKind.Repository,
        externalKey: { adapter: 'fake', key: id },
        capabilities: [],
      },
      checkoutRevision: assignment.sourceRevision,
    };
    const provider = new GitWorkspaceProvider(join(root, 'workspaces'), resolver, workspaceLocks);
    const lease = await provider.acquire(request);
    expect(await git(lease.path, 'rev-parse', 'HEAD')).toBe(assignment.sourceRevision);
    expect(await readFile(join(lease.path, 'file'), 'utf8')).toBe(id);
    expect(lease.assignment?.pullRequestBase).toBe('integration');
    if (id === 'b')
      expect(await readFile(join(lease.path, 'upstream'), 'utf8')).toBe('unmerged change');
    await writeFile(join(lease.path, 'dirty'), 'retain me');
    await lease.release();
    const restarted = new GitWorkspaceProvider(join(root, 'workspaces'), resolver, workspaceLocks);
    const next = await restarted.acquire({ ...request, runId: runId('retry-' + id) });
    expect(await readFile(join(next.path, 'dirty'), 'utf8')).toBe('retain me');
    expect(next.checkoutRevision).toBe(assignment.sourceRevision);
    await next.release();
    await expect(
      restarted.acquire({ ...request, assignment: { ...assignment, pullRequestBase: 'other' } }),
    ).rejects.toThrow('assignment changed');
  }
  const revision = await git(repositories.a, 'rev-parse', 'HEAD');
  await expect(
    resolveGitSource(resolver, {
      resourceId: resId('b'),
      sourceRef: 'main',
      sourceRevision: revision,
      pullRequestBase: 'main',
    }),
  ).rejects.toThrow('publish the source to the selected repository');
  await expect(
    resolveGitSource(resolver, {
      resourceId: resId('a'),
      sourceRef: 'missing',
      pullRequestBase: 'main',
    }),
  ).rejects.toThrow('source missing is unavailable');
});

it('keeps the clone default for a new branch when no repository assignment pins a source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-direct-branch-'));
  roots.push(root);
  const path = await repository(root, 'direct');
  const first = await git(path, 'rev-parse', 'HEAD');
  await writeFile(join(path, 'file'), 'later');
  await git(path, 'commit', '-am', 'later');
  const head = await git(path, 'rev-parse', 'HEAD');
  const resolver = { cloneLocator: async () => path };
  const provider = new GitWorkspaceProvider(join(root, 'workspaces'), resolver, workspaceLocks);
  const lease = await provider.acquire({
    runId: runId('run-direct'),
    signal: new AbortController().signal,
    workItemId: workId('direct'),
    mode: 'branch' as const,
    repositoryResource: {
      resourceId: resId('direct'),
      kind: BuiltInResourceKind.Repository,
      externalKey: { adapter: 'fake', key: 'direct' },
      capabilities: [],
    },
    checkoutRevision: first,
  });
  expect(await git(lease.path, 'rev-parse', 'HEAD')).toBe(head);
  await lease.release();
});
