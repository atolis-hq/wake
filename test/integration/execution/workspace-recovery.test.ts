import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runId,
  RunStatus,
  type RunView,
  type WorkspaceRecovery,
} from '../../../src/execution/index.js';
import { GitWorkspaceProvider } from '../../../src/execution/infrastructure/workspace/git-workspace.js';

const roots: string[] = [];

describe('GitWorkspaceProvider workspace recovery', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('retains an owned workspace for an open WorkItem after a terminal Run', async () => {
    const root = await workspaceRoot();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' });
    const terminal = await ownedWorkspace(root, 'terminal', 'terminal-run');

    await (provider as WorkspaceRecovery).recover([
      run('terminal-run', RunStatus.Succeeded),
    ], { retainWorkItem: async () => true } as never);

    await expect(access(terminal.path)).resolves.toBeUndefined();
    await expect(access(terminal.markerPath)).resolves.toBeUndefined();
  });

  it('reclaims an owned workspace once its WorkItem is closed or deleted', async () => {
    const root = await workspaceRoot();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' });
    const closed = await ownedWorkspace(root, 'closed', 'closed-run');
    const deleted = await ownedWorkspace(root, 'deleted', 'deleted-run');

    await (provider as WorkspaceRecovery).recover(
      [run('closed-run', RunStatus.Succeeded), run('deleted-run', RunStatus.Cancelled)],
      { retainWorkItem: async () => false },
    );

    await expect(access(closed.path)).rejects.toThrow();
    await expect(access(closed.markerPath)).rejects.toThrow();
    await expect(access(deleted.path)).rejects.toThrow();
    await expect(access(deleted.markerPath)).rejects.toThrow();
  });

  it('retains started and ambiguous owned workspaces', async () => {
    const root = await workspaceRoot();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' });
    const started = await ownedWorkspace(root, 'started', 'started-run');
    const ambiguous = await ownedWorkspace(root, 'ambiguous', 'ambiguous-run');

    await (provider as WorkspaceRecovery).recover([
      run('started-run', RunStatus.Started),
      run('ambiguous-run', RunStatus.Ambiguous),
    ]);

    await expect(access(started.path)).resolves.toBeUndefined();
    await expect(access(started.markerPath)).resolves.toBeUndefined();
    await expect(access(ambiguous.path)).resolves.toBeUndefined();
    await expect(access(ambiguous.markerPath)).resolves.toBeUndefined();
  });

  it('never reclaims a workspace while another Run using its path is active', async () => {
    const root = await workspaceRoot();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' });
    const workspace = await ownedWorkspace(root, 'shared', 'finished-run');
    const active = {
      ...run('active-run', RunStatus.Started),
      workspace: { mode: 'branch' as const, path: workspace.path, branch: 'work-active' },
    };

    await (provider as WorkspaceRecovery).recover(
      [run('finished-run', RunStatus.Succeeded), active],
      { retainWorkItem: async () => false },
    );

    await expect(access(workspace.path)).resolves.toBeUndefined();
    await expect(access(workspace.markerPath)).resolves.toBeUndefined();
  });

  it('stops before the next owned workspace when the existing dispatch pause becomes active', async () => {
    const root = await workspaceRoot();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' });
    const first = await ownedWorkspace(root, 'a-first', 'first-run');
    const later = await ownedWorkspace(root, 'b-later', 'later-run');
    let checks = 0;

    const result = await (provider as WorkspaceRecovery).recover([], {
      isPaused: async () => ++checks > 1,
    });

    expect(result.reclaimed).toBe(1);
    await expect(access(first.path)).rejects.toThrow();
    await expect(access(first.markerPath)).rejects.toThrow();
    await expect(access(later.path)).resolves.toBeUndefined();
    await expect(access(later.markerPath)).resolves.toBeUndefined();
  });

  it('retains unknown directories, malformed markers, and out-of-root marker paths', async () => {
    const root = await workspaceRoot();
    const provider = new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' });
    const unknownPath = join(root, 'unknown-directory');
    await mkdir(unknownPath, { recursive: true });
    const markerRoot = join(root, '.wake-workspace-ownership');
    const malformedMarker = join(markerRoot, 'malformed.json');
    await writeFile(malformedMarker, '{not json', 'utf8');
    const outsidePath = resolve(root, '..', 'outside-workspace');
    roots.push(outsidePath);
    const outside = await ownedWorkspace(root, 'outside', 'outside-run', outsidePath);

    await (provider as WorkspaceRecovery).recover([]);

    await expect(access(unknownPath)).resolves.toBeUndefined();
    await expect(access(malformedMarker)).resolves.toBeUndefined();
    await expect(access(outside.path)).resolves.toBeUndefined();
    await expect(access(outside.markerPath)).resolves.toBeUndefined();
  });

  it('continues after a deletion error and is idempotent', async () => {
    const root = await workspaceRoot();
    const failed = await ownedWorkspace(root, 'failed-delete', 'failed-run');
    const reclaimed = await ownedWorkspace(root, 'reclaimed', 'reclaimed-run');
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'unused' },
      undefined,
      {
        remove: async (path) => {
          if (path === failed.path) throw new Error('locked');
          await rm(path, { recursive: true, force: true });
        },
        canonicalize: realpath,
      },
    );

    const first = await (provider as WorkspaceRecovery).recover([]);
    const second = await (provider as WorkspaceRecovery).recover([]);

    expect(first.failures).toEqual([
      expect.objectContaining({ path: failed.path, message: 'locked' }),
    ]);
    expect(second.failures).toEqual([
      expect.objectContaining({ path: failed.path, message: 'locked' }),
    ]);

    await expect(access(failed.path)).resolves.toBeUndefined();
    await expect(access(failed.markerPath)).resolves.toBeUndefined();
    await expect(access(reclaimed.path)).rejects.toThrow();
    await expect(access(reclaimed.markerPath)).rejects.toThrow();
  });

  it('continues after a marker canonicalization error and reclaims later valid markers', async () => {
    const root = await workspaceRoot();
    const broken = await ownedWorkspace(root, 'broken-marker', 'broken-run');
    const reclaimed = await ownedWorkspace(root, 'later-valid', 'later-run');
    const provider = new GitWorkspaceProvider(
      root,
      { cloneLocator: async () => 'unused' },
      undefined,
      {
        remove: async (path: string) => rm(path, { recursive: true, force: true }),
        canonicalize: async (path: string) => {
          if (path === broken.markerPath) throw new Error('marker access denied');
          return realpath(path);
        },
      } as never,
    );

    const result = await (provider as WorkspaceRecovery).recover([]);

    expect(result).toMatchObject({
      reclaimed: 1,
      failures: [
        expect.objectContaining({ markerPath: broken.markerPath, message: 'marker access denied' }),
      ],
    });
    await expect(access(broken.path)).resolves.toBeUndefined();
    await expect(access(broken.markerPath)).resolves.toBeUndefined();
    await expect(access(reclaimed.path)).rejects.toThrow();
    await expect(access(reclaimed.markerPath)).rejects.toThrow();
  });

  it('never treats the ownership marker directory itself as a workspace', async () => {
    const root = await workspaceRoot();
    const markerRoot = join(root, '.wake-workspace-ownership');
    const markerPath = join(markerRoot, '.wake-workspace-ownership.json');
    await writeFile(
      markerPath,
      ownershipMarker('.wake-workspace-ownership', 'marker-root', markerRoot),
      'utf8',
    );

    await (
      new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' }) as WorkspaceRecovery
    ).recover([]);

    await expect(access(markerRoot)).resolves.toBeUndefined();
    await expect(access(markerPath)).resolves.toBeUndefined();
  });

  it('retains a lexical workspace path that resolves through a symlink or junction outside the root', async () => {
    const root = await workspaceRoot();
    const outside = await mkdtemp(join(tmpdir(), 'wake-workspace-outside-'));
    roots.push(outside);
    const path = join(root, 'linked-workspace');
    await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
    const markerPath = join(root, '.wake-workspace-ownership', 'linked-workspace.json');
    await writeFile(markerPath, ownershipMarker('linked-workspace', 'linked-run', path), 'utf8');

    await (
      new GitWorkspaceProvider(root, { cloneLocator: async () => 'unused' }) as WorkspaceRecovery
    ).recover([]);

    await expect(access(path)).resolves.toBeUndefined();
    await expect(access(markerPath)).resolves.toBeUndefined();
    await expect(access(outside)).resolves.toBeUndefined();
  });
});

async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-workspace-recovery-'));
  roots.push(root);
  await mkdir(join(root, '.wake-workspace-ownership'), { recursive: true });
  return root;
}

async function ownedWorkspace(
  root: string,
  workspaceId: string,
  id: string,
  path = join(root, workspaceId),
) {
  const markerPath = join(root, '.wake-workspace-ownership', `${workspaceId}.json`);
  await mkdir(path, { recursive: true });
  await writeFile(markerPath, ownershipMarker(workspaceId, id, path), 'utf8');
  return { path, markerPath };
}

function ownershipMarker(workspaceId: string, id: string, path: string): string {
  return JSON.stringify({
    runId: id,
    workItemId: 'work-00000000000000000000000000',
    repositoryResourceId: 'resource-00000000000000000000000000',
    mode: 'read-only',
    workspaceId,
    path,
  });
}

function run(id: string, status: RunView['status']): RunView {
  return {
    runId: runId(id),
    activationId: 'activation' as never,
    activity: 'activity' as never,
    workflowInstanceId: 'workflow' as never,
    orchestrationGroupId: 'group' as never,
    attempt: 1,
    status,
    ambiguityAttempts: 0,
    escalated: false,
    startedAt: '2026-08-11T12:00:00.000Z',
  };
}
