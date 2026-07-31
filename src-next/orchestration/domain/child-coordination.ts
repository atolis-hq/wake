import type { StartWorkflowInstance } from '../contracts/commands.js';
import type { ChildCoordinationMetadata, ChildWorkflowRequest } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';

export function causalCycleId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('causalCycleId' in payload))
    return undefined;
  const cycle = payload.causalCycleId;
  return typeof cycle === 'string' ? cycle : undefined;
}

export function childMetadata(child: WorkflowInstanceView): ChildCoordinationMetadata {
  if (
    child.parentWorkflowInstanceId === undefined ||
    child.watchId === undefined ||
    child.triggerId === undefined ||
    child.causalCycleId === undefined ||
    child.requestId === undefined
  )
    throw new Error('Child workflow metadata is incomplete');
  return {
    parentWorkflowInstanceId: child.parentWorkflowInstanceId,
    watchId: child.watchId,
    triggerId: child.triggerId,
    orchestrationGroupId: child.orchestrationGroupId,
    causalCycleId: child.causalCycleId,
    requestId: child.requestId,
    childWorkflowInstanceId: child.workflowInstanceId,
  };
}

export function validateChildProvenance(command: StartWorkflowInstance): 'primary' | 'child' {
  const values = [
    command.parentWorkflowInstanceId,
    command.watchId,
    command.triggerId,
    command.causalCycleId,
    command.requestId,
  ];
  const provided = values.filter((value) => value !== undefined).length;
  if (provided === 0) return 'primary';
  if (provided !== values.length) throw new Error('Complete child provenance must be provided');
  if (command.requestId !== command.workflowInstanceId)
    throw new Error('Child request id must equal its WorkflowInstance id');
  return 'child';
}

export function childRequestId(request: ChildWorkflowRequest): string {
  return `${request.parentWorkflowInstanceId}:watch:${request.watchId}:trigger:${request.triggerId}`;
}

export function coordinationMetadata(
  parent: WorkflowInstanceView,
  request: ChildWorkflowRequest,
): ChildCoordinationMetadata {
  return {
    parentWorkflowInstanceId: parent.workflowInstanceId,
    watchId: request.watchId,
    triggerId: request.triggerId,
    orchestrationGroupId: parent.orchestrationGroupId,
    causalCycleId: request.causalCycleId,
    requestId: request.requestId,
    childWorkflowInstanceId: request.requestId,
  };
}
