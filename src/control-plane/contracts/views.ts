import type { WorkflowStatus } from '../../orchestration/index.js';
import type { WorkItemId } from '../../work/index.js';

export interface DispatchedRun {
  readonly activationId: string;
  readonly runId: string;
}

export type AdvanceResult =
  | { readonly kind: 'no-work' }
  | { readonly kind: 'progressed'; readonly dispatched: readonly DispatchedRun[] }
  | { readonly kind: typeof WorkflowStatus.Waiting; readonly workflowInstanceId: string }
  | {
      readonly kind: typeof WorkflowStatus.Blocked;
      readonly workflowInstanceId: string;
      readonly reason: string;
    }
  | { readonly kind: 'paused' }
  | { readonly kind: 'exhausted'; readonly progressCount: number };

export interface AdvanceOptions {
  readonly workItemId?: WorkItemId;
  readonly maxProgress: number;
}
