export interface WorkflowInstanceResponse {
  readonly workflowInstanceId: string;
  readonly workItemKey: string;
  readonly workflowName: string;
  readonly orchestrationGroupId: string;
  readonly parentWorkflowInstanceId?: string;
  readonly status: string;
  readonly currentStage: string;
  readonly waitingFor?: { readonly signalKind: string };
}
