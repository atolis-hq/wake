export interface WorkflowInstanceResponse {
  readonly workflowInstanceId: string;
  readonly workItemKey: string;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
  readonly parentWorkflowInstanceId?: string;
  readonly status: string;
  readonly currentStage: string;
  /** Why a blocked workflow requires operator intervention. */
  readonly blockReason?: string;
  readonly retryEligible?: boolean;
  readonly waitingFor?: { readonly signalKind: string };
}
