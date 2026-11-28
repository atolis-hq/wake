import {
  isGroupBudgetExtensionEligible,
  isOperatorRetryEligible,
  observedRetryDescription,
  workflowDisplayStatus,
  WorkflowDisplayStatus,
  WorkflowStatus,
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
    displayStatus: workflowDisplayStatus(value),
    currentStage: value.currentStage,
    ...observedRetryCondition(value),
    ...((value.status === WorkflowStatus.Blocked ||
      (value.status === WorkflowStatus.Waiting &&
        workflowDisplayStatus(value) === WorkflowDisplayStatus.Failed)) &&
    value.blockReason !== undefined
      ? { blockReason: value.blockReason }
      : {}),
    ...(isOperatorRetryEligible(value) ? { retryEligible: true } : {}),
    ...(isGroupBudgetExtensionEligible(value) ? { extendEligible: true } : {}),
    ...(value.waitingFor === undefined
      ? {}
      : { waitingFor: { signalKind: value.waitingFor.signalKind } }),
  };
}

function observedRetryCondition(value: WorkflowInstanceView): { retryCondition?: string } {
  if (value.status !== WorkflowStatus.Waiting || value.waitingFor?.observed === undefined)
    return {};
  return {
    retryCondition: observedRetryDescription(
      value.waitingFor.observed,
      value.observedRetry?.activationId === value.pendingActivation?.activationId &&
        value.observedRetry?.exhausted,
    ),
  };
}
