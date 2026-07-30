import type { WorkItemId } from '../../work/index.js';
export type AdvanceResult =
  | { readonly kind: 'no-work' }
  | { readonly kind: 'progressed'; readonly activationId: string; readonly runId: string }
  | { readonly kind: 'waiting'; readonly workflowInstanceId: string }
  | { readonly kind: 'blocked'; readonly workflowInstanceId: string; readonly reason: string }
  | { readonly kind: 'exhausted'; readonly progressCount: number };
export interface AdvanceOptions {
  readonly workItemId?: WorkItemId;
  readonly maxProgress: number;
}
