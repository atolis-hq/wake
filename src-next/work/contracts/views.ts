import type { LinkWorkItems } from './commands.js';
import type { WorkItemId } from './identifiers.js';
import type { WorkStatus } from './vocabulary.js';

export type WorkState =
  typeof WorkStatus.Open | typeof WorkStatus.Closed | typeof WorkStatus.Cancelled;

export interface RelatedWorkItemView {
  readonly workItemId: WorkItemId;
  readonly relation: LinkWorkItems['relation'];
}

export interface WorkItemView {
  readonly workItemId: WorkItemId;
  readonly objective: string;
  readonly state: WorkState;
  readonly tags: readonly string[];
  // Operator consent for `auto` acceptance authority; capability is declared by the workflow route.
  readonly autoApprovalGranted: boolean;
  readonly relatedWorkItems: readonly RelatedWorkItemView[];
}
