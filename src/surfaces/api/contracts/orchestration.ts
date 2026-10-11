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
  readonly extendEligible?: boolean;
  readonly mergePolicyBlock?: MergePolicyBlockResponse;
  readonly waitingFor?: { readonly signalKind: string };
}

export interface MergePolicyBlockResponse {
  readonly status: 'awaiting-human-merge' | 'recovering';
  readonly explanation: string;
  readonly nextAction: string;
  readonly href?: string;
  readonly policy?: {
    readonly blockedPaths?: readonly string[] | undefined;
    readonly matchedPaths?: readonly string[] | undefined;
    readonly maxFilesChanged?: number | undefined;
    readonly filesChanged?: number | undefined;
  };
}
