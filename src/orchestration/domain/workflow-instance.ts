import type {
  WorkflowOrchestrationEvent,
  WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
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

type WorkflowFact = WorkflowOrchestrationEvent | WorkflowOrchestrationEventDraft;

export function foldWorkflowInstance(events: readonly WorkflowFact[]): WorkflowInstanceView | null {
  const first = events.find((event) => event.eventType === OrchestrationEventType.InstanceStarted);
  if (first === undefined) return null;
  const state: MutableWorkflowInstance = {
    workflowInstanceId: first.stream.id,
    workItemId: first.payload.workItemId,
    workflowName: first.payload.workflowName,
    orchestrationGroupId: first.payload.orchestrationGroupId,
    ...optionalChildFields(first.payload),
    status: WorkflowStatus.Active,
    currentStage: first.payload.entry,
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
  for (const event of events) applyWorkflowInstanceEvent(state, event);
  return immutableWorkflowInstanceView(state);
}

function optionalChildFields(
  payload: Extract<
    WorkflowFact,
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
