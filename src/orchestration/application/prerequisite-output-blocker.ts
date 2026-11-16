import type { DelegationPrerequisite } from '../contracts/delegation.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationPrerequisiteCondition as Condition,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { isSuccessfulWorkflowCompletion } from '../domain/workflow-completion.js';

export function outputBlocker(edge: DelegationPrerequisite, assignment: string, reason?: string) {
  const prefix = `Waiting for ${edge.condition} output ${assignment}/${edge.output}`;
  return reason === undefined ? prefix : prefix + ': ' + reason;
}

export function workflowReason(workflow: WorkflowInstanceView, edge: DelegationPrerequisite) {
  if (workflow.status === WorkflowStatus.Completed && !isSuccessfulWorkflowCompletion(workflow))
    return 'Upstream workflow failed';
  if (edge.condition === Condition.DeliveryReady && !isSuccessfulWorkflowCompletion(workflow))
    return 'Waiting for delivery-ready upstream';
  if (workflow.status === WorkflowStatus.Superseded) return 'Upstream workflow was superseded';
  return undefined;
}
