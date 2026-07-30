import type { ActivityOutcome } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
export interface StartWorkflowInstance {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
}
export interface AcceptActivityOutcomeCommand {
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly outcome: ActivityOutcome;
}
