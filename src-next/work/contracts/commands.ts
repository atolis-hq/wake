import type { WorkItemId } from './identifiers.js';

export interface CreateWorkItem {
  readonly workItemId: WorkItemId;
  readonly objective: string;
  // Wake-owned classification assigned by an operator-authored intake rule.
  readonly tags?: readonly string[];
}

export interface ReviseWorkObjective {
  readonly workItemId: WorkItemId;
  readonly objective: string;
}

export interface LinkWorkItems {
  readonly from: WorkItemId;
  readonly to: WorkItemId;
  readonly relation: 'relates-to' | 'parent-of' | 'child-of';
}
