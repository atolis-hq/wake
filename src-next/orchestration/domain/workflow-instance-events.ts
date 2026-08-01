import type { ActivationId } from '../../activities/index.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';
import { ActivityActivationStatus, WorkflowStatus } from '../contracts/vocabulary.js';

type WorkflowFact = WorkflowOrchestrationEvent | WorkflowOrchestrationEventDraft;
type FactsOf<Type extends WorkflowFact['eventType']> = Extract<
  WorkflowFact,
  { readonly eventType: Type }
>;

export type MutableWorkflowInstance = {
  workflowInstanceId: WorkflowInstanceView['workflowInstanceId'];
  workItemId: WorkflowInstanceView['workItemId'];
  workflowName: WorkflowInstanceView['workflowName'];
  orchestrationGroupId: WorkflowInstanceView['orchestrationGroupId'];
  parentWorkflowInstanceId?: WorkflowInstanceView['parentWorkflowInstanceId'];
  watchId?: string;
  triggerId?: string;
  causalCycleId?: string;
  requestId?: string;
  status: WorkflowInstanceView['status'];
  currentStage: WorkflowInstanceView['currentStage'];
  pendingActivation?: ActivityActivationView;
  repeatCounts: Record<string, number>;
  retryCounts: Record<string, number>;
  waitingFor?: WorkflowInstanceView['waitingFor'];
  supplementalQueue: Array<WorkflowInstanceView['supplementalQueue'][number]>;
  acceptedSignalIds: string[];
  acceptedOutcomes: ActivationId[];
  acceptedChildCompletionIds: WorkflowInstanceView['workflowInstanceId'][];
  causalRejectionIds: string[];
  childCompletionRecorded: boolean;
  lastOutcome?: WorkflowInstanceView['lastOutcome'];
};

type ActivityFact = FactsOf<
  | typeof OrchestrationEventType.StageEntered
  | typeof OrchestrationEventType.ActivityRequested
  | typeof OrchestrationEventType.ActivityStarted
  | typeof OrchestrationEventType.ActivityOutcomeAccepted
  | typeof OrchestrationEventType.ActivityWaiting
>;
type InteractionFact = FactsOf<
  | typeof OrchestrationEventType.SignalWaitStarted
  | typeof OrchestrationEventType.SignalAccepted
  | typeof OrchestrationEventType.SupplementalActivityQueued
  | typeof OrchestrationEventType.SupplementalActivityDequeued
>;
type LifecycleFact = FactsOf<
  | typeof OrchestrationEventType.RepeatCounted
  | typeof OrchestrationEventType.RetryCounted
  | typeof OrchestrationEventType.InstanceCompleted
  | typeof OrchestrationEventType.InstanceBlocked
  | typeof OrchestrationEventType.InstanceSuperseded
>;
type CoordinationFact = Exclude<WorkflowFact, ActivityFact | InteractionFact | LifecycleFact>;

export function applyWorkflowInstanceEvent(
  state: MutableWorkflowInstance,
  event: WorkflowFact,
): void {
  if (isActivityFact(event)) return applyActivityFact(state, event);
  if (isInteractionFact(event)) return applyInteractionFact(state, event);
  if (isLifecycleFact(event)) return applyLifecycleFact(state, event);
  applyCoordinationFact(state, event);
}

function isActivityFact(event: WorkflowFact): event is ActivityFact {
  switch (event.eventType) {
    case OrchestrationEventType.StageEntered:
    case OrchestrationEventType.ActivityRequested:
    case OrchestrationEventType.ActivityStarted:
    case OrchestrationEventType.ActivityOutcomeAccepted:
    case OrchestrationEventType.ActivityWaiting:
      return true;
    default:
      return false;
  }
}

function applyActivityFact(state: MutableWorkflowInstance, event: ActivityFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.StageEntered:
      state.currentStage = event.payload.stage;
      return;
    case OrchestrationEventType.ActivityRequested:
      applyActivityRequested(state, event.payload);
      return;
    case OrchestrationEventType.ActivityStarted:
      updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Running);
      return;
    case OrchestrationEventType.ActivityOutcomeAccepted:
      state.acceptedOutcomes.push(event.payload.activationId);
      state.lastOutcome = event.payload.outcome;
      updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Completed);
      return;
    case OrchestrationEventType.ActivityWaiting:
      applyActivityWaiting(state, event);
      return;
    default:
      assertNever(event);
  }
}

function isInteractionFact(event: WorkflowFact): event is InteractionFact {
  switch (event.eventType) {
    case OrchestrationEventType.SignalWaitStarted:
    case OrchestrationEventType.SignalAccepted:
    case OrchestrationEventType.SupplementalActivityQueued:
    case OrchestrationEventType.SupplementalActivityDequeued:
      return true;
    default:
      return false;
  }
}

function applyInteractionFact(state: MutableWorkflowInstance, event: InteractionFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.SignalWaitStarted:
      applySignalWaitStarted(state, event);
      return;
    case OrchestrationEventType.SignalAccepted:
      state.status = WorkflowStatus.Active;
      state.acceptedSignalIds.push(event.payload.providerEventId);
      delete state.waitingFor;
      return;
    case OrchestrationEventType.SupplementalActivityQueued:
      state.supplementalQueue.push(event.payload);
      return;
    case OrchestrationEventType.SupplementalActivityDequeued:
      state.supplementalQueue.shift();
      return;
    default:
      assertNever(event);
  }
}

function isLifecycleFact(event: WorkflowFact): event is LifecycleFact {
  switch (event.eventType) {
    case OrchestrationEventType.RepeatCounted:
    case OrchestrationEventType.RetryCounted:
    case OrchestrationEventType.InstanceCompleted:
    case OrchestrationEventType.InstanceBlocked:
    case OrchestrationEventType.InstanceSuperseded:
      return true;
    default:
      return false;
  }
}

function applyLifecycleFact(state: MutableWorkflowInstance, event: LifecycleFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.RepeatCounted:
      state.repeatCounts[event.payload.routeId] = event.payload.count;
      return;
    case OrchestrationEventType.RetryCounted:
      state.retryCounts[event.payload.retryKey] = event.payload.count;
      return;
    case OrchestrationEventType.InstanceCompleted:
      state.status = WorkflowStatus.Completed;
      delete state.pendingActivation;
      delete state.waitingFor;
      return;
    case OrchestrationEventType.InstanceBlocked:
      state.status = WorkflowStatus.Blocked;
      return;
    case OrchestrationEventType.InstanceSuperseded:
      state.status = WorkflowStatus.Superseded;
      return;
    default:
      assertNever(event);
  }
}

function applyCoordinationFact(state: MutableWorkflowInstance, event: CoordinationFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.InstanceStarted:
    case OrchestrationEventType.ChildRequested:
    case OrchestrationEventType.ChildStarted:
    case OrchestrationEventType.GroupBudgetExhausted:
      return;
    case OrchestrationEventType.ChildCompleted:
      state.childCompletionRecorded = true;
      return;
    case OrchestrationEventType.ChildCompletionConsumed:
      state.acceptedChildCompletionIds.push(event.payload.childWorkflowInstanceId);
      return;
    case OrchestrationEventType.CausalActivationRejected:
      state.causalRejectionIds.push(event.payload.triggerId);
      return;
    default:
      assertNever(event);
  }
}

function applyActivityWaiting(
  state: MutableWorkflowInstance,
  event: FactsOf<typeof OrchestrationEventType.ActivityWaiting>,
): void {
  state.status = WorkflowStatus.Waiting;
  state.waitingFor = {
    signalKind: event.payload.outcome.data.signalKind,
    intentEventId: event.payload.outcome.data.intentEventId,
  };
  state.lastOutcome = event.payload.outcome;
  updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Waiting);
}

function applySignalWaitStarted(
  state: MutableWorkflowInstance,
  event: FactsOf<typeof OrchestrationEventType.SignalWaitStarted>,
): void {
  state.status = WorkflowStatus.Waiting;
  state.waitingFor = {
    signalKind: event.payload.signalKind,
    ...(event.payload.resourceId === undefined ? {} : { resourceId: event.payload.resourceId }),
    ...(event.payload.revision === undefined ? {} : { revision: event.payload.revision }),
    ...(event.payload.from === undefined ? {} : { from: event.payload.from }),
    ...(event.payload.resume === undefined ? {} : { resume: event.payload.resume }),
  };
}

function updateActivationStatus(
  state: MutableWorkflowInstance,
  activationId: ActivationId,
  status: ActivityActivationView['status'],
): void {
  if (state.pendingActivation?.activationId === activationId)
    state.pendingActivation = { ...state.pendingActivation, status };
}

function applyActivityRequested(
  state: MutableWorkflowInstance,
  payload: FactsOf<typeof OrchestrationEventType.ActivityRequested>['payload'],
): void {
  state.status = WorkflowStatus.Active;
  delete state.waitingFor;
  state.pendingActivation = {
    activationId: payload.activationId,
    ordinal: payload.ordinal,
    activity: payload.activity,
    input: payload.input,
    execution: payload.execution,
    status: ActivityActivationStatus.Pending,
    ...(payload.followOnIndex === undefined ? {} : { followOnIndex: payload.followOnIndex }),
    ...(payload.supplemental === true ? { supplemental: true } : {}),
  };
}

export function immutableWorkflowInstanceView(
  state: MutableWorkflowInstance,
): WorkflowInstanceView {
  return {
    workflowInstanceId: state.workflowInstanceId,
    workItemId: state.workItemId,
    workflowName: state.workflowName,
    orchestrationGroupId: state.orchestrationGroupId,
    ...(state.parentWorkflowInstanceId === undefined
      ? {}
      : { parentWorkflowInstanceId: state.parentWorkflowInstanceId }),
    ...(state.watchId === undefined ? {} : { watchId: state.watchId }),
    ...(state.triggerId === undefined ? {} : { triggerId: state.triggerId }),
    ...(state.causalCycleId === undefined ? {} : { causalCycleId: state.causalCycleId }),
    ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
    status: state.status,
    currentStage: state.currentStage,
    repeatCounts: state.repeatCounts,
    retryCounts: state.retryCounts,
    supplementalQueue: state.supplementalQueue,
    acceptedSignalIds: state.acceptedSignalIds,
    acceptedOutcomes: state.acceptedOutcomes,
    acceptedChildCompletionIds: state.acceptedChildCompletionIds,
    causalRejectionIds: state.causalRejectionIds,
    childCompletionRecorded: state.childCompletionRecorded,
    ...(state.pendingActivation === undefined
      ? {}
      : { pendingActivation: state.pendingActivation }),
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.waitingFor === undefined ? {} : { waitingFor: state.waitingFor }),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WorkflowInstance event: ${JSON.stringify(value)}`);
}
