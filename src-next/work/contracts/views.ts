import { WorkStatus } from './vocabulary.js';
import type { LinkWorkItems } from './commands.js';
import type { WorkItemId } from './identifiers.js';

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
  readonly relatedWorkItems: readonly RelatedWorkItemView[];
}
