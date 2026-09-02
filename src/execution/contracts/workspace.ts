import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { RunId } from './identifiers.js';
import type { RunView } from './views.js';
import type { WorkspaceMode } from './vocabulary.js';

export interface WorkspaceRequest {
  readonly runId: RunId;
  readonly signal: AbortSignal;
  readonly mode: typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch;
  readonly workItemId: WorkItemId;
  readonly repositoryResource: ResourceView;
}

export interface WorkspaceLease {
  readonly workspaceId: string;
  readonly path: string;
  /** Branch actually checked out for this lease, when the provider can attest it. */
  readonly branch?: string | undefined;
  readonly mode: WorkspaceRequest['mode'];
  /** Ends this Run's use of the workspace; branch-workspace disposal is WorkItem-scoped recovery. */
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
