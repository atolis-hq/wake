import type { WorkflowOrchestrationEvent } from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import {
  applyWorkflowInstanceEvent,
  immutableWorkflowInstanceView,
  orchestrationStatusTransitions,
  type MutableWorkflowInstance,
} from './workflow-instance-events.js';

export { orchestrationStatusTransitions };

export function foldWorkflowInstance(
  events: readonly WorkflowOrchestrationEvent[],
): WorkflowInstanceView | null {
  const first = events.find(
    (event) => event.event.eventType === OrchestrationEventType.InstanceStarted,
  );
  if (first === undefined) return null;
  if (first.event.eventType !== OrchestrationEventType.InstanceStarted) return null;
  const state: MutableWorkflowInstance = {
    workflowInstanceId: first.stream.id,
    workItemId: first.event.payload.workItemId,
    workflowName: first.event.payload.workflowName,
    ...(first.event.payload.workflowDefinitionFingerprint === undefined
      ? {}
      : { workflowDefinitionFingerprint: first.event.payload.workflowDefinitionFingerprint }),
    orchestrationGroupId: first.event.payload.orchestrationGroupId,
    ...optionalChildFields(first.event.payload),
    status: WorkflowStatus.Active,
    currentStage: first.event.payload.entry,
    repeatCounts: {},
    retryCounts: {},
    supplementalQueue: [],
    acceptedSignalIds: [],
    operatorRetryCommandIds: [],
    acceptedOutcomes: [],
    acceptedChildCompletionIds: [],
    causalRejectionIds: [],
    childCompletionRecorded: false,
  };
  for (const event of events) applyWorkflowInstanceEvent(state, event.event);
  return immutableWorkflowInstanceView(state);
}

function optionalChildFields(
  payload: Extract<
    WorkflowOrchestrationEvent['event'],
    { eventType: typeof OrchestrationEventType.InstanceStarted }
  >['payload'],
): Pick<
  MutableWorkflowInstance,
  'parentWorkflowInstanceId' | 'watchId' | 'triggerId' | 'causalCycleId' | 'requestId'
> {
  return 'parentWorkflowInstanceId' in payload
    ? {
        parentWorkflowInstanceId: payload.parentWorkflowInstanceId,
        watchId: payload.watchId,
        triggerId: payload.triggerId,
        causalCycleId: payload.causalCycleId,
        requestId: payload.requestId,
      }
    : {};
}
