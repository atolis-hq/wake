import type { ExecutionCancellationReason } from './vocabulary.js';
import type { RunView } from './views.js';

/** Host-facing recovery hook. Control Plane invokes this before new work is dispatched. */
export interface RecoveryCoordinator {
  recoverActive(owner: string): Promise<readonly RunView[]>;
}

/** Cancels every active Run belonging to the supplied workflow instances. */
export interface ActiveRunCancellation {
  cancelActive(
    workflowInstanceIds: readonly string[],
    reason: ExecutionCancellationReason,
  ): Promise<readonly RunView[]>;
}
