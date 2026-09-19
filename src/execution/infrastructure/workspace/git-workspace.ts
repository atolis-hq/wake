/* eslint-disable max-lines */

import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WorkItemId } from '../../../work/index.js';
import type { RunView } from '../../contracts/views.js';
import { isActiveRunStatus, RunStatus, WorkspaceMode } from '../../contracts/vocabulary.js';
import type {
  WorkspaceProvider,
  WorkspaceRecovery,
  WorkspaceRecoveryFailure,
  WorkspaceRecoveryOptions,
  WorkspaceRecoveryResult,
  WorkspaceRequest,
} from '../../contracts/workspace.js';
import { prepareWorkspace, type WorkspacePrepareHook } from './prepare-workspace.js';

const exec = promisify(execFile);

export interface RepositoryCloneResolver {
  cloneLocator(resourceId: string, signal: AbortSignal): Promise<string>;
}

export type GitRunner = (arguments_: readonly string[], signal: AbortSignal) => Promise<void>;

export interface WorkspaceRecoveryFileSystem {
  remove(path: string): Promise<void>;
  canonicalize(path: string): Promise<string>;
}

export class GitWorkspaceProvider implements WorkspaceProvider, WorkspaceRecovery {
  private readonly markerRoot: string;
  private readonly recoveryFileSystem: WorkspaceRecoveryFileSystem;

  constructor(
    private readonly root: string,
    private readonly resolver: RepositoryCloneResolver,
    private readonly git: GitRunner = async (arguments_, signal) => {
      await exec('git', arguments_, { signal });
    },
    recoveryFileSystem: WorkspaceRecoveryFileSystem = {
      remove: async (path) =>
        rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      canonicalize: realpath,
    },
    private readonly prepareHook?: WorkspacePrepareHook,
  ) {
    this.markerRoot = join(this.root, '.wake-workspace-ownership');
    this.recoveryFileSystem = recoveryFileSystem;
  }

  async acquire(request: WorkspaceRequest) {
    const { signal } = request;
    signal.throwIfAborted();
    const locator = await this.resolver.cloneLocator(request.repositoryResource.resourceId, signal);
    signal.throwIfAborted();
    const name = `${request.workItemId}-${request.mode}-${slug(locator)}`;
    const path = resolve(this.root, name);
    const markerPath = join(this.markerRoot, `${name}.json`);
    const lockPath = join(this.markerRoot, `${name}.lock`);
    await mkdir(dirname(markerPath), { recursive: true });
    await acquireLock(lockPath, request.runId, signal);
    try {
      const previousMarker = await readMarker(markerPath);
      let initialRevision = previousMarker?.initialRevision;
      signal.throwIfAborted();
      const writeMarker = async () =>
        writeFile(
          markerPath,
          JSON.stringify({
            runId: request.runId,
            workItemId: request.workItemId,
            repositoryResourceId: request.repositoryResource.resourceId,
            mode: request.mode,
            workspaceId: name,
            path,
            ...(initialRevision === undefined ? {} : { initialRevision }),
          }),
          { encoding: 'utf8', signal },
        );
      await writeMarker();
      const existingWorkspace = await exists(join(path, '.git'), signal);
      if (!existingWorkspace) {
        await mkdir(dirname(path), { recursive: true });
        signal.throwIfAborted();
        await this.git(['clone', locator, path], signal);
        initialRevision = await initialCloneRevision(path);
        await writeMarker();
      }
      const branch = request.mode === WorkspaceMode.Branch ? request.workItemId : undefined;
      if (branch !== undefined) {
        await this.git(
          ['-C', path, 'switch', ...(existingWorkspace ? [] : ['--create']), branch],
          signal,
        );
      } else {
        await restoreReadOnlyWorkspace(
          path,
          request.repositoryResource.revision,
          initialRevision,
          this.git,
          signal,
        );
      }
      if (this.prepareHook !== undefined) await prepareWorkspace(path, this.prepareHook, signal);
      signal.throwIfAborted();
      let released = false;
      return {
        workspaceId: name,
        path,
        mode: request.mode,
        ...(branch === undefined ? {} : { branch }),
        release: async () => {
          if (released) return;
          released = true;
          // Workspaces are WorkItem-scoped. Recovery reclaims the marker-owned tree
          // only after its WorkItem is no longer retained.
          await releaseLock(lockPath, request.runId);
        },
      };
    } catch (error) {
      await releaseLock(lockPath, request.runId);
      throw error;
    }
  }

  async recover(
    runs: readonly RunView[],
    options: WorkspaceRecoveryOptions = {},
  ): Promise<WorkspaceRecoveryResult> {
    const scope = await recoveryScope(this.root, this.markerRoot);
    if (scope === null) return emptyRecovery();
    const markers = await recoveryMarkerNames(this.markerRoot);
    let reclaimed = 0;
    const reclaimedWorkItemIds: WorkItemId[] = [];
    const failures: WorkspaceRecoveryFailure[] = [];
    for (const filename of markers) {
      if (await options.isPaused?.()) break;
      const result = await recoverMarker({
        filename,
        markerRoot: this.markerRoot,
        scope,
        runs,
        fileSystem: this.recoveryFileSystem,
        options,
      });
      reclaimed += result.reclaimed;
      reclaimedWorkItemIds.push(...(result.reclaimedWorkItemIds ?? []));
      failures.push(...result.failures);
    }
    return { reclaimed, reclaimedWorkItemIds, failures };
  }
}

interface RecoveryScope {
  readonly root: string;
  readonly markerRoot: string;
}

async function recoveryScope(root: string, markerRoot: string): Promise<RecoveryScope | null> {
  const canonicalRoot = await canonicalPath(root);
  const canonicalMarkerRoot = await canonicalPath(markerRoot);
  if (
    canonicalRoot === null ||
    canonicalMarkerRoot === null ||
    !isStrictDescendant(canonicalRoot, canonicalMarkerRoot)
  ) {
    return null;
  }
  return { root: canonicalRoot, markerRoot: canonicalMarkerRoot };
}

async function recoveryMarkerNames(markerRoot: string): Promise<readonly string[]> {
  try {
    return await readdir(markerRoot);
  } catch {
    return [];
  }
}

async function recoverMarker(input: {
  readonly filename: string;
  readonly markerRoot: string;
  readonly scope: RecoveryScope;
  readonly runs: readonly RunView[];
  readonly fileSystem: WorkspaceRecoveryFileSystem;
  readonly options: WorkspaceRecoveryOptions;
}): Promise<WorkspaceRecoveryResult> {
  if (!input.filename.endsWith('.json')) return emptyRecovery();
  const markerPath = join(input.markerRoot, input.filename);
  const marker = await readMarker(markerPath);
  try {
    return await reclaimOwnedMarker(input, markerPath, marker);
  } catch (error) {
    return {
      reclaimed: 0,
      failures: [{ markerPath, path: marker?.path ?? markerPath, message: errorMessage(error) }],
    };
  }
}

async function reclaimOwnedMarker(
  input: {
    readonly scope: RecoveryScope;
    readonly runs: readonly RunView[];
    readonly fileSystem: WorkspaceRecoveryFileSystem;
    readonly options: WorkspaceRecoveryOptions;
  },
  markerPath: string,
  marker: WorkspaceOwnershipMarker | null,
): Promise<WorkspaceRecoveryResult> {
  if (
    marker === null ||
    !(await isOwnedWorkspace(input.scope, markerPath, marker, input.fileSystem))
  )
    return emptyRecovery();
  const lockPath = join(input.scope.markerRoot, `${marker.workspaceId}.lock`);
  if (!(await acquireRecoveryLock(lockPath, marker.runId, input.runs))) return emptyRecovery();
  try {
    const current = await readMarker(markerPath);
    if (current === null || current.runId !== marker.runId) return emptyRecovery();
    return await reclaimUnlockedMarker(input, markerPath, current);
  } finally {
    await releaseLock(lockPath, marker.runId);
  }
}

async function reclaimUnlockedMarker(
  input: {
    readonly scope: RecoveryScope;
    readonly runs: readonly RunView[];
    readonly fileSystem: WorkspaceRecoveryFileSystem;
    readonly options: WorkspaceRecoveryOptions;
  },
  markerPath: string,
  marker: WorkspaceOwnershipMarker,
): Promise<WorkspaceRecoveryResult> {
  if (
    input.runs.some(
      (run) =>
        (isActiveRunStatus(run.status) || run.status === RunStatus.Ambiguous) &&
        (run.runId === marker.runId || run.workspace?.path === marker.path),
    )
  )
    return emptyRecovery();
  if ((await input.options.retainWorkItem?.(marker.workItemId as never)) === true)
    return emptyRecovery();
  if (!(await canRemoveOwnedWorkspace(input.scope, marker.path))) return emptyRecovery();
  if ((await canonicalPath(marker.path)) !== null) await input.fileSystem.remove(marker.path);
  if ((await input.options.onWorkspaceReclaimed?.(marker.workItemId as WorkItemId)) === false)
    return emptyRecovery();
  await rm(markerPath, { force: true });
  return {
    reclaimed: 1,
    reclaimedWorkItemIds: [marker.workItemId as WorkItemId],
    failures: [],
  };
}

function emptyRecovery(): WorkspaceRecoveryResult {
  return { reclaimed: 0, reclaimedWorkItemIds: [], failures: [] };
}

async function canRemoveOwnedWorkspace(scope: RecoveryScope, path: string): Promise<boolean> {
  const canonicalTarget = await canonicalPath(path);
  return (
    canonicalTarget === null ||
    (isStrictDescendant(scope.root, canonicalTarget) &&
      !isDescendantOrSame(scope.markerRoot, canonicalTarget))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WorkspaceOwnershipMarker {
  readonly runId: string;
  readonly workItemId: string;
  readonly repositoryResourceId: string;
  readonly mode: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly initialRevision?: string;
}

async function readMarker(path: string): Promise<WorkspaceOwnershipMarker | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isOwnershipMarker(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isOwnershipMarker(value: unknown): value is WorkspaceOwnershipMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.runId === 'string' &&
    typeof marker.workItemId === 'string' &&
    typeof marker.repositoryResourceId === 'string' &&
    (marker.mode === WorkspaceMode.ReadOnly || marker.mode === WorkspaceMode.Branch) &&
    typeof marker.workspaceId === 'string' &&
    typeof marker.path === 'string' &&
    (marker.initialRevision === undefined || typeof marker.initialRevision === 'string')
  );
}

async function isOwnedWorkspace(
  scope: RecoveryScope,
  markerPath: string,
  marker: WorkspaceOwnershipMarker,
  fileSystem: WorkspaceRecoveryFileSystem,
): Promise<boolean> {
  if (!isSafeWorkspaceId(marker.workspaceId)) return false;
  if (basename(markerPath) !== `${marker.workspaceId}.json`) return false;
  if (!isAbsolute(marker.path)) return false;
  const expectedPath = resolve(scope.root, marker.workspaceId);
  if (resolve(marker.path) !== expectedPath) return false;
  if (!isStrictDescendant(scope.root, expectedPath)) return false;
  if (isDescendantOrSame(scope.markerRoot, expectedPath)) return false;
  const canonicalMarkerPath = await canonicalizeMarkerPath(fileSystem, markerPath);
  if (canonicalMarkerPath === null) return false;
  return isStrictDescendant(scope.markerRoot, canonicalMarkerPath);
}

async function canonicalizeMarkerPath(
  fileSystem: WorkspaceRecoveryFileSystem,
  path: string,
): Promise<string | null> {
  try {
    return await fileSystem.canonicalize(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isSafeWorkspaceId(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && basename(value) === value;
}

function isStrictDescendant(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
}

function isDescendantOrSame(root: string, target: string): boolean {
  return root === target || isStrictDescendant(root, target);
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function exists(path: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  try {
    await access(path);
    signal.throwIfAborted();
    return true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function restoreReadOnlyWorkspace(
  path: string,
  revision: string | undefined,
  initialRevision: string | undefined,
  git: GitRunner,
  signal: AbortSignal,
): Promise<void> {
  if (revision !== undefined) {
    await git(['-C', path, 'fetch', 'origin', revision], signal);
    await git(['-C', path, 'checkout', '--detach', revision], signal);
    await git(['-C', path, 'reset', '--hard', revision], signal);
    return;
  }
  await git(['-C', path, 'reset', '--hard', initialRevision ?? 'HEAD'], signal);
}

async function initialCloneRevision(path: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['-C', path, 'rev-parse', 'HEAD']);
    return result.stdout.trim() || undefined;
  } catch {
    // Test and alternate git runners may attest a checkout without a real
    // Git object database; legacy HEAD fallback remains safe for those trees.
    return undefined;
  }
}

const lockRetryMs = 25;

async function acquireLock(path: string, runId: string, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    try {
      await mkdir(path);
      await writeFile(join(path, runId), '', 'utf8');
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await waitForLock(signal);
    }
  }
}

async function acquireRecoveryLock(
  path: string,
  markerRunId: string,
  runs: readonly RunView[],
): Promise<boolean> {
  try {
    await mkdir(path);
    await writeFile(join(path, markerRunId), '', 'utf8');
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  // Only clear a crash-stale lock when it attests the same terminal/absent
  // owner as the marker we inspected. A newer acquisition has a different
  // lock owner and is never disturbed by recovery of an older marker.
  const owner = await readLockOwner(path);
  if (owner === null) {
    // A crash between mkdir and owner-entry creation leaves an empty lock
    // directory. It cannot represent an active lease and must not strand
    // future acquisition.
    try {
      await rmdir(path);
    } catch (error) {
      if (!isNotFound(error) && !isNotEmpty(error)) throw error;
    }
    return false;
  }
  if (
    runs.some(
      (run) =>
        run.runId === owner &&
        (isActiveRunStatus(run.status) || run.status === RunStatus.Ambiguous),
    )
  )
    return false;
  // An absent or terminal lock owner is a crash orphan even if it acquired
  // the lock before it could replace an older marker. Removing it makes the
  // next recovery/acquisition pass progress without disturbing an active run.
  await releaseLock(path, owner);
  return false;
}

async function readLockOwner(path: string): Promise<string | null> {
  try {
    const owners = await readdir(path);
    return owners.length === 1 ? owners[0]! : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function releaseLock(path: string, owner: string): Promise<void> {
  try {
    await unlink(join(path, owner));
    await rmdir(path);
  } catch (error) {
    if (!isNotFound(error) && !isNotEmpty(error)) throw error;
  }
}

function isNotEmpty(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOTEMPTY'
  );
}

function waitForLock(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, lockRetryMs);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }

    signal.addEventListener('abort', abort, { once: true });
  });
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
