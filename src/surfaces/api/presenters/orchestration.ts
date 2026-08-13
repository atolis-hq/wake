import {
  isOperatorRetryEligible,
  type WorkflowInstanceView,
} from '../../../orchestration/index.js';
import type { WorkflowInstanceResponse } from '../contracts/orchestration.js';
import { toWorkItemKey } from '../contracts/work.js';

export function presentWorkflowInstance(value: WorkflowInstanceView): WorkflowInstanceResponse {
  return {
    workflowInstanceId: value.workflowInstanceId,
    workItemKey: toWorkItemKey(value.workItemId),
    workflowName: value.workflowName,
    orchestrationGroupId: value.orchestrationGroupId,
    ...(value.parentWorkflowInstanceId === undefined
      ? {}
      : { parentWorkflowInstanceId: value.parentWorkflowInstanceId }),
    status: value.status,
    currentStage: value.currentStage,
    ...(isOperatorRetryEligible(value) ? { retryEligible: true } : {}),
    ...(value.waitingFor === undefined
      ? {}
      : { waitingFor: { signalKind: value.waitingFor.signalKind } }),
  };
}
