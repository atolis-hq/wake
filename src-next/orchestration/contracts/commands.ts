import type { ActivityOutcome } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
interface StartWorkflowBase {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
}
type PrimaryWorkflowStart = {
  readonly parentWorkflowInstanceId?: never;
  readonly watchId?: never;
  readonly triggerId?: never;
  readonly causalCycleId?: never;
  readonly requestId?: never;
};
type ChildWorkflowStart = {
  readonly parentWorkflowInstanceId: string;
  readonly watchId: string;
  readonly triggerId: string;
  readonly causalCycleId: string;
  readonly requestId: string;
};
export type StartWorkflowInstance = StartWorkflowBase & (PrimaryWorkflowStart | ChildWorkflowStart);
export interface AcceptActivityOutcomeCommand {
  readonly workflowInstanceId: string;
  readonly activationId: string;
  readonly outcome: ActivityOutcome;
}
