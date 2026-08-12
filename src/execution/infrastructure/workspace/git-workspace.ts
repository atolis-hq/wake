import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RunView } from '../../contracts/views.js';
import { RunStatus, WorkspaceMode } from '../../contracts/vocabulary.js';
import type {
  WorkspaceProvider,
  WorkspaceRecovery,
  WorkspaceRecoveryFailure,
  WorkspaceRecoveryOptions,
  WorkspaceRecoveryResult,
  WorkspaceRequest,
} from '../../contracts/workspace.js';

const exec = promisify(execFile);

export interface RepositoryCloneResolver {
  cloneLocator(resourceId: string): Promise<string>;
}

export type GitRunner = (arguments_: readonly string[]) => Promise<void>;

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
    private readonly git: GitRunner = async (arguments_) => {
      await exec('git', arguments_);
    },
    recoveryFileSystem: WorkspaceRecoveryFileSystem = {
      remove: async (path) =>
        rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
      canonicalize: realpath,
    },
  ) {
    this.markerRoot = join(this.root, '.wake-workspace-ownership');
    this.recoveryFileSystem = recoveryFileSystem;
  }

  async acquire(request: WorkspaceRequest) {
    const locator = await this.resolver.cloneLocator(request.repositoryResource.resourceId);
    const name = `${request.workItemId}-${request.mode}-${slug(locator)}`;
    const path = resolve(this.root, name);
    const markerPath = join(this.markerRoot, `${name}.json`);
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
    const existingWorkspace = await exists(join(path, '.git'));
    if (!existingWorkspace) {
      await mkdir(dirname(path), { recursive: true });
      await this.git(['clone', locator, path]);
    }
    const branch = request.mode === WorkspaceMode.Branch ? request.workItemId : undefined;
    if (branch !== undefined)
      await this.git([
        '-C',
        path,
        'switch',
        ...(existingWorkspace ? [] : ['--create']),
        branch,
      ]);
    return {
      workspaceId: name,
      path,
      mode: request.mode,
      ...(branch === undefined ? {} : { branch }),
      release: async () => {
        if (request.mode !== WorkspaceMode.ReadOnly) return;
        await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        await rm(markerPath, { force: true });
      },
    };
  }

  async recover(
    runs: readonly RunView[],
    options: WorkspaceRecoveryOptions = {},
  ): Promise<WorkspaceRecoveryResult> {
    const scope = await recoveryScope(this.root, this.markerRoot);
    if (scope === null) return emptyRecovery();
    const markers = await recoveryMarkerNames(this.markerRoot);
    let reclaimed = 0;
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
      failures.push(...result.failures);
    }
    return { reclaimed, failures };
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
  if (
    input.runs.some(
      (run) =>
        (run.status === RunStatus.Started || run.status === RunStatus.Ambiguous) &&
        (run.runId === marker.runId || run.workspace?.path === marker.path),
    )
  )
    return emptyRecovery();
  if ((await input.options.retainWorkItem?.(marker.workItemId as never)) === true)
    return emptyRecovery();
  if (!(await canRemoveOwnedWorkspace(input.scope, marker.path))) return emptyRecovery();
  if ((await canonicalPath(marker.path)) !== null) await input.fileSystem.remove(marker.path);
  await rm(markerPath, { force: true });
  return { reclaimed: 1, failures: [] };
}

function emptyRecovery(): WorkspaceRecoveryResult {
  return { reclaimed: 0, failures: [] };
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
    typeof marker.path === 'string'
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
