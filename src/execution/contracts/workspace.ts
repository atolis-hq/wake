import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { PreparedCandidate } from './candidate.js';
import type { ChangeOutputWorkspace } from './change-output.js';
import type { RunId } from './identifiers.js';
import type { PreparedMaintenance } from './maintenance.js';
import type { RepositoryAssignment } from './repository-assignment.js';
import type { RunView } from './views.js';
import type { WorkspaceMode } from './vocabulary.js';

export interface WorkspaceRequest {
  readonly outputName?: string;
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
  readonly workItemId: WorkItemId;
  readonly repositoryResource: ResourceView;
  /** Git checkout target, independent of the resource observation revision. */
  readonly checkoutRevision?: string;
  readonly requiredSourceRef?: string;
  readonly assignment?: RepositoryAssignment;
}

export interface WorkspaceLease {
  readonly changeOutputs?: readonly ChangeOutputWorkspace[];
  readChangeOutputs?(): Promise<readonly ChangeOutputWorkspace[]>;
  readonly candidate?: PreparedCandidate;
  readonly maintenance?: PreparedMaintenance;
  readonly workspaceId: string;
  readonly path: string;
  /** Branch actually checked out for this lease, when the provider can attest it. */
  readonly branch?: string | undefined;
  readonly mode: WorkspaceRequest['mode'];
  readonly repositoryResourceId?: string;
  readonly checkoutRevision?: string;
  readonly assignment?: RepositoryAssignment;
  /** Ends this Run's use of the workspace; workspace disposal is WorkItem-scoped recovery. */
  readRevision?(): Promise<string>;
  release(): Promise<void>;
}

export interface WorkspaceProvider {
  acquire(request: WorkspaceRequest): Promise<WorkspaceLease>;
}

/** Optional capability for reclaiming workspaces whose journal owner is safe to remove. */
export interface WorkspaceRecovery {
  recover(
    runs: readonly RunView[],
    options?: WorkspaceRecoveryOptions,
  ): Promise<WorkspaceRecoveryResult>;
}

/** Existing control-plane pause state, sampled between independent reclaims. */
export interface WorkspaceRecoveryOptions {
  isPaused?(): Promise<boolean>;
  /** Whether this WorkItem still owns its workspace after its active Runs finish. */
  retainWorkItem?(workItemId: WorkItemId): Promise<boolean>;
  /** Called after an owned workspace is removed; false preserves its marker for retry. */
  onWorkspaceReclaimed?(workItemId: WorkItemId): Promise<boolean>;
}

export interface WorkspaceRecoveryResult {
  readonly reclaimed: number;
  /** WorkItems whose owned workspace was successfully reclaimed in this pass. */
  readonly reclaimedWorkItemIds?: readonly WorkItemId[];
  readonly failures: readonly WorkspaceRecoveryFailure[];
}

/** A recoverable cleanup failure retained for the next startup pass. */
export interface WorkspaceRecoveryFailure {
  readonly markerPath: string;
  readonly path: string;
  readonly message: string;
}

/** Process-owned exclusion shared by acquisition and recovery. */
export interface WorkspaceLockProvider {
  tryAcquire(path: string): Promise<WorkspaceLock>;
}

export interface WorkspaceLock {
  readonly acquired: boolean;
  release(): Promise<void>;
}

export interface RepositoryCloneResolver {
  cloneLocator(resourceId: string, signal: AbortSignal): Promise<string>;
}
