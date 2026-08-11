import type { ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { RunId } from './identifiers.js';
import type { RunView } from './views.js';
import type { WorkspaceMode } from './vocabulary.js';

export interface WorkspaceRequest {
  readonly runId: RunId;
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
  release(): Promise<void>;
}

export interface WorkspaceProvider {
  acquire(request: WorkspaceRequest): Promise<WorkspaceLease>;
}

/** Optional capability for reclaiming workspaces whose journal owner is safe to remove. */
export interface WorkspaceRecovery {
  recover(runs: readonly RunView[]): Promise<WorkspaceRecoveryResult>;
}

export interface WorkspaceRecoveryResult {
  readonly reclaimed: number;
  readonly failures: readonly WorkspaceRecoveryFailure[];
}

/** A recoverable cleanup failure retained for the next startup pass. */
export interface WorkspaceRecoveryFailure {
  readonly markerPath: string;
  readonly path: string;
  readonly message: string;
}
