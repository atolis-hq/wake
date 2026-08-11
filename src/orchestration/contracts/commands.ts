import type { ActivationId, ActivityOutcome } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { OrchestrationGroupId, WorkflowInstanceId, WorkflowName } from './identifiers.js';

interface StartWorkflowBase {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly workItemId: WorkItemId;
  readonly workflowName: WorkflowName;
  readonly orchestrationGroupId: OrchestrationGroupId;
}

type PrimaryWorkflowStart = {
  readonly parentWorkflowInstanceId?: never;
  readonly watchId?: never;
  readonly triggerId?: never;
  readonly causalCycleId?: never;
  readonly requestId?: never;
};

type ChildWorkflowStart = {
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
  readonly watchId: string;
  readonly triggerId: string;
  readonly causalCycleId: string;
  readonly requestId: string;
};

export type StartWorkflowInstance = StartWorkflowBase & (PrimaryWorkflowStart | ChildWorkflowStart);

export interface AcceptActivityOutcomeCommand {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly activationId: ActivationId;
  readonly outcome: ActivityOutcome;
}
