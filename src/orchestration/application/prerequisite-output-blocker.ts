import type { DelegationArtifacts } from '../contracts/delegation-ports.js';
import type { DelegatedAssignment, DelegationPrerequisite } from '../contracts/delegation.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  DelegationPrerequisiteCondition as Condition,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import { isSuccessfulWorkflowCompletion } from '../domain/workflow-completion.js';

export async function outputBlocker(
  artifacts: DelegationArtifacts,
  workflow: WorkflowInstanceView,
  output: DelegatedAssignment['outputs'][number],
  edge: DelegationPrerequisite,
  assignment: string,
) {
  const prefix = `Waiting for ${edge.condition} output ${assignment}/${edge.output}`;
  if (artifacts.prerequisiteOutputBlocker === undefined) return prefix;
  return (
    prefix +
    ': ' +
    ((await artifacts.prerequisiteOutputBlocker(workflow, output, edge.condition)) ??
      'qualifying evidence unavailable')
  );
}

export function workflowReason(workflow: WorkflowInstanceView, edge: DelegationPrerequisite) {
  if (workflow.status === WorkflowStatus.Completed && !isSuccessfulWorkflowCompletion(workflow))
    return 'Upstream workflow failed';
  if (edge.condition === Condition.DeliveryReady && !isSuccessfulWorkflowCompletion(workflow))
    return 'Waiting for delivery-ready upstream';
  if (workflow.status === WorkflowStatus.Superseded) return 'Upstream workflow was superseded';
  return undefined;
}
