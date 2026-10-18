/* eslint-disable max-lines */

import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import type { WorkItemId } from '../../../work/index.js';
import {
  repositoryAssignmentSchema,
  type RepositoryAssignment,
} from '../../contracts/repository-assignment.js';
import type { RunView } from '../../contracts/views.js';
import { isActiveRunStatus, RunStatus, WorkspaceMode } from '../../contracts/vocabulary.js';
import type {
  WorkspaceLock,
  WorkspaceLockProvider,
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

export type GitRunner = (
  arguments_: readonly string[],
  signal: AbortSignal,
) => Promise<string | void>;

export interface WorkspaceRecoveryFileSystem {
  remove(path: string): Promise<void>;
  canonicalize(path: string): Promise<string>;
}

export class GitWorkspaceProvider implements WorkspaceProvider, WorkspaceRecovery {
  private readonly markerRoot: string;
  private readonly recoveryFileSystem: WorkspaceRecoveryFileSystem;
  private readonly pendingReleases = new Map<string, WorkspaceLock>();

  constructor(
    private readonly root: string,
    private readonly resolver: RepositoryCloneResolver,
    private readonly locks: WorkspaceLockProvider,
    private readonly git: GitRunner = async (arguments_, signal) => {
      return (await exec('git', arguments_, { signal })).stdout.trim();
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
    const lockPath = join(this.markerRoot, `${name}.lease`);
    await mkdir(dirname(markerPath), { recursive: true });
    const scope = await recoveryScope(this.root, this.markerRoot);
    if (scope === null)
      throw new Error('Workspace ownership directory is outside the managed root');
    await validateLeasePaths(scope, lockPath);
    const lock = await acquireWorkspaceLock(this.locks, lockPath, signal);
    try {
      const branch = await this.prepareCheckout(request, locator, name, path, markerPath);
      if (this.prepareHook !== undefined) await prepareWorkspace(path, this.prepareHook, signal);
      signal.throwIfAborted();
      let released = false;
      return {
        workspaceId: name,
        path,
        mode: request.mode,
        readRevision: () => readCheckoutRevision(path, this.git, signal),
        repositoryResourceId: request.repositoryResource.resourceId,
        checkoutRevision: await readCheckoutRevision(path, this.git, signal),
        ...(request.assignment === undefined ? {} : { assignment: request.assignment }),
        ...(branch === undefined ? {} : { branch }),
        release: async () => {
          if (released) return;
          await this.releaseWorkspaceLock(lockPath, lock);
          released = true;
        },
      };
    } catch (error) {
      await this.releaseWorkspaceLock(lockPath, lock);
      throw error;
    }
  }

  private async releaseWorkspaceLock(path: string, lock: WorkspaceLock): Promise<void> {
    try {
      await lock.release();
      if (this.pendingReleases.get(path) === lock) this.pendingReleases.delete(path);
    } catch (error) {
      this.pendingReleases.set(path, lock);
      throw error;
    }
  }

  private async prepareCheckout(
    request: WorkspaceRequest,
    locator: string,
    name: string,
    path: string,
    markerPath: string,
  ): Promise<string | undefined> {
    const { signal } = request;
    const previousMarker = await readMarker(markerPath);
    assertAssignment(previousMarker, request);
    if (await exists(join(this.markerRoot, `${name}.lock`), signal))
      throw new Error('Legacy workspace lock requires recovery before acquisition');
    let initialRevision = previousMarker?.initialRevision;
    let checkoutReady: boolean;
    signal.throwIfAborted();
    const writeMarker = () =>
      writeOwnershipMarker(
        markerPath,
        {
          runId: request.runId,
          workItemId: request.workItemId,
          repositoryResourceId: request.repositoryResource.resourceId,
          mode: request.mode,
          workspaceId: name,
          path,
          checkoutReady,
          ...(request.assignment === undefined ? {} : { assignment: request.assignment }),
          ...(initialRevision === undefined ? {} : { initialRevision }),
        },
        signal,
      );
    const existingWorkspace = await this.reuseCheckout(
      previousMarker,
      markerPath,
      path,
      request.mode,
      signal,
    );
    checkoutReady = previousMarker?.checkoutReady ?? existingWorkspace;
    if (!existingWorkspace) {
      initialRevision = undefined;
      checkoutReady = false;
    }
    await writeMarker();
    if (!existingWorkspace) {
      await mkdir(dirname(path), { recursive: true });
      signal.throwIfAborted();
      await this.git(['clone', locator, path], signal);
    }
    if (initialRevision === undefined)
      initialRevision = await readCheckoutRevision(path, this.git, signal);
    const branch = request.mode === WorkspaceMode.Branch ? request.workItemId : undefined;
    if (branch !== undefined) {
      initialRevision = await initializeBranch(
        {
          path,
          branch,
          // Only repository assignments pin a new branch; direct workflows keep the clone default.
          revision: request.assignment === undefined ? undefined : request.checkoutRevision,
          initialRevision,
          existing: existingWorkspace,
        },
        this.git,
        signal,
      );
    }
    checkoutReady = true;
    await writeMarker();
    if (branch === undefined) {
      await restoreReadOnlyWorkspace(
        path,
        request.checkoutRevision,
        initialRevision,
        this.git,
        signal,
      );
    }
    return branch;
  }

  private async reuseCheckout(
    marker: WorkspaceOwnershipMarker | null,
    markerPath: string,
    path: string,
    mode: WorkspaceRequest['mode'],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!(await exists(path, signal))) return false;
    const scope = await recoveryScope(this.root, this.markerRoot);
    if (
      scope === null ||
      marker === null ||
      !(await isOwnedWorkspace(scope, markerPath, marker, this.recoveryFileSystem)) ||
      !(await canRemoveOwnedWorkspace(scope, path))
    )
      throw new Error('Cannot acquire an unvalidated existing workspace');
    if (marker.checkoutReady === false) {
      await this.recoveryFileSystem.remove(path);
      return false;
    }
    if (!(await exists(join(path, '.git'), signal))) {
      if (mode === WorkspaceMode.Branch)
        throw new Error('Cannot reuse a branch checkout without Git metadata');
      await this.recoveryFileSystem.remove(path);
      return false;
    }
    return this.validateLegacyCheckout(marker, path, mode, signal);
  }

  private async validateLegacyCheckout(
    marker: WorkspaceOwnershipMarker,
    path: string,
    mode: WorkspaceRequest['mode'],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (marker.checkoutReady !== undefined || mode !== WorkspaceMode.ReadOnly) return true;
    try {
      await readCheckoutRevision(path, this.git, signal);
      return true;
    } catch {
      signal.throwIfAborted();
      // Legacy read-only clones may predate the durable completion flag.
      await this.recoveryFileSystem.remove(path);
      return false;
    }
  }

  async recover(
    runs: readonly RunView[],
    options: WorkspaceRecoveryOptions = {},
  ): Promise<WorkspaceRecoveryResult> {
    const scope = await recoveryScope(this.root, this.markerRoot);
    if (scope === null) return emptyRecovery();
    const releaseFailures: WorkspaceRecoveryFailure[] = [];
    for (const [path, lock] of this.pendingReleases) {
      if (await options.isPaused?.()) break;
      try {
        await this.releaseWorkspaceLock(path, lock);
      } catch (error) {
        releaseFailures.push({ markerPath: path, path, message: errorMessage(error) });
      }
    }
    const names = await recoveryMarkerNames(this.markerRoot);
    const workspaceIds = new Set(
      names.flatMap((name) => {
        const match = /^(.*)\.(?:json(?:\.pending)?|lock|lease(?:\.owners)?)$/.exec(name);
        return match !== null && isSafeWorkspaceId(match[1]!) ? [match[1]!] : [];
      }),
    );
    let reclaimed = 0;
    const reclaimedWorkItemIds: WorkItemId[] = [];
    const failures: WorkspaceRecoveryFailure[] = [...releaseFailures];
    for (const workspaceId of workspaceIds) {
      if (await options.isPaused?.()) break;
      const result = await recoverWorkspace({
        workspaceId,
        markerRoot: this.markerRoot,
        scope,
        runs,
        fileSystem: this.recoveryFileSystem,
        options,
        locks: this.locks,
        releaseLock: (path, lock) => this.releaseWorkspaceLock(path, lock),
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

async function validateLeasePaths(scope: RecoveryScope, path: string): Promise<void> {
  for (const target of [
    path,
    `${path}.owners`,
    `${path.slice(0, -'.lease'.length)}.lock`,
    `${path.slice(0, -'.lease'.length)}.json.pending`,
  ]) {
    const canonical = await canonicalPath(target);
    if (canonical !== null && canonical !== join(scope.markerRoot, basename(target)))
      throw new Error('Workspace lease artifacts must not be symbolic links');
  }
}

async function recoverWorkspace(input: {
  readonly workspaceId: string;
  readonly markerRoot: string;
  readonly scope: RecoveryScope;
  readonly runs: readonly RunView[];
  readonly fileSystem: WorkspaceRecoveryFileSystem;
  readonly options: WorkspaceRecoveryOptions;
  readonly locks: WorkspaceLockProvider;
  readonly releaseLock: (path: string, lock: WorkspaceLock) => Promise<void>;
}): Promise<WorkspaceRecoveryResult> {
  const markerPath = join(input.markerRoot, `${input.workspaceId}.json`);
  let marker: WorkspaceOwnershipMarker | null = null;
  try {
    const lockPath = join(input.markerRoot, `${input.workspaceId}.lease`);
    await validateLeasePaths(input.scope, lockPath);
    const lock = await input.locks.tryAcquire(lockPath);
    if (!lock.acquired) return emptyRecovery();
    try {
      if (
        !(await recoverLegacyLock(join(input.markerRoot, `${input.workspaceId}.lock`), input.runs))
      )
        return emptyRecovery();
      await rm(`${markerPath}.pending`, { force: true });
      marker = await readMarker(markerPath);
      if (
        marker === null ||
        !(await isOwnedWorkspace(input.scope, markerPath, marker, input.fileSystem))
      )
        return emptyRecovery();
      return await reclaimUnlockedMarker(input, markerPath, marker);
    } finally {
      await input.releaseLock(lockPath, lock);
    }
  } catch (error) {
    return {
      reclaimed: 0,
      failures: [{ markerPath, path: marker?.path ?? markerPath, message: errorMessage(error) }],
    };
  }
}

// Migration only: new acquisitions never create directory locks.
async function recoverLegacyLock(path: string, runs: readonly RunView[]): Promise<boolean> {
  if ((await canonicalPath(path)) === null) return true;
  const owner = await readLockOwner(path);
  if (owner === undefined) return false;
  if (owner === null && runs.some(protectsWorkspace)) return false;
  if (owner !== null && runs.some((run) => run.runId === owner && protectsWorkspace(run)))
    return false;
  if (owner !== null) await unlink(join(path, owner));
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return true;
    if (isNotEmpty(error)) return false;
    throw error;
  }
}

function protectsWorkspace(run: RunView): boolean {
  return isActiveRunStatus(run.status) || run.status === RunStatus.Ambiguous;
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
  await rm(`${markerPath}.pending`, { force: true });
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
  readonly assignment?: RepositoryAssignment;
  readonly initialRevision?: string;
  readonly checkoutReady?: boolean;
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
    hasValidCheckoutState(marker)
  );
}

function hasValidCheckoutState(marker: Record<string, unknown>): boolean {
  return (
    (marker.assignment === undefined ||
      repositoryAssignmentSchema.safeParse(marker.assignment).success) &&
    (marker.initialRevision === undefined || typeof marker.initialRevision === 'string') &&
    (marker.checkoutReady === undefined || typeof marker.checkoutReady === 'boolean')
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
  initialRevision: string,
  git: GitRunner,
  signal: AbortSignal,
): Promise<void> {
  if (revision !== undefined) {
    await git(['-C', path, 'fetch', 'origin', revision], signal);
    const fetched = await readGitRevision(path, 'FETCH_HEAD^{commit}', git, signal);
    await git(['-C', path, 'checkout', '--detach', '--force', fetched], signal);
    await git(['-C', path, 'reset', '--hard', fetched], signal);
    return;
  }
  await git(['-C', path, 'reset', '--hard', initialRevision], signal);
}

async function readCheckoutRevision(
  path: string,
  git: GitRunner,
  signal: AbortSignal,
): Promise<string> {
  return readGitRevision(path, 'HEAD^{commit}', git, signal);
}

async function readGitRevision(
  path: string,
  reference: string,
  git: GitRunner,
  signal: AbortSignal,
): Promise<string> {
  const revision = await git(['-C', path, 'rev-parse', '--verify', reference], signal);
  if (typeof revision !== 'string' || revision.trim() === '')
    throw new Error('Git runner did not attest a valid workspace HEAD');
  return revision.trim();
}

async function writeOwnershipMarker(
  path: string,
  marker: WorkspaceOwnershipMarker,
  signal: AbortSignal,
): Promise<void> {
  const pending = `${path}.pending`;
  try {
    await writeFile(pending, JSON.stringify(marker), { encoding: 'utf8', signal });
    signal.throwIfAborted();
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

async function acquireWorkspaceLock(
  locks: WorkspaceLockProvider,
  path: string,
  signal: AbortSignal,
): Promise<WorkspaceLock> {
  while (true) {
    signal.throwIfAborted();
    const lock = await locks.tryAcquire(path);
    if (lock.acquired) return lock;
    await waitForLock(signal);
  }
}

async function readLockOwner(path: string): Promise<string | null | undefined> {
  try {
    const owners = await readdir(path);
    if (owners.length === 0) return null;
    return owners.length === 1 ? owners[0]! : undefined;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotEmpty(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOTEMPTY'
  );
}

function waitForLock(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, 25);
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

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function assertAssignment(
  previousMarker: WorkspaceOwnershipMarker | null,
  request: WorkspaceRequest,
): void {
  if (
    previousMarker !== null &&
    previousMarker.repositoryResourceId !== request.repositoryResource.resourceId
  )
    throw new Error('Workspace belongs to a different Repository Resource');
  if (
    previousMarker?.assignment !== undefined &&
    !isDeepStrictEqual(previousMarker.assignment, request.assignment)
  )
    throw new Error(
      'Workspace repository assignment changed; reconcile the existing branch before retrying',
    );
}

async function initializeBranch(
  input: {
    path: string;
    branch: string;
    revision: string | undefined;
    initialRevision: string;
    existing: boolean;
  },
  git: GitRunner,
  signal: AbortSignal,
): Promise<string> {
  const { path, branch, revision, existing } = input;
  let { initialRevision } = input;
  if (!existing && revision !== undefined) {
    await git(['-C', path, 'fetch', 'origin', revision], signal);
    const fetched = await readGitRevision(path, 'FETCH_HEAD^{commit}', git, signal);
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision) && fetched !== revision)
      throw new Error('Fetched source differs from the pinned checkout revision');
    initialRevision = fetched;
  }
  await git(
    [
      '-C',
      path,
      'switch',
      ...(existing ? [] : ['--create']),
      branch,
      ...(!existing && revision !== undefined ? [initialRevision] : []),
    ],
    signal,
  );
  return initialRevision;
}
