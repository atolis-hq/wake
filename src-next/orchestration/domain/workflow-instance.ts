import {
  OrchestrationEventType,
  type WorkflowOrchestrationEvent,
  type WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';

type WorkflowFact = WorkflowOrchestrationEvent | WorkflowOrchestrationEventDraft;

export function foldWorkflowInstance(events: readonly WorkflowFact[]): WorkflowInstanceView | null {
  const first = events.find((event) => event.eventType === OrchestrationEventType.InstanceStarted);
  if (first === undefined) return null;
  const state: Mutable = {
    workflowInstanceId: first.stream.id,
    workItemId: first.payload.workItemId,
    workflowName: first.payload.workflowName,
    orchestrationGroupId: first.payload.orchestrationGroupId,
    ...optionalChildFields(first.payload),
    status: 'active',
    currentStage: first.payload.entry,
    repeatCounts: {},
    retryCounts: {},
    supplementalQueue: [],
    acceptedSignalIds: [],
    acceptedOutcomes: [],
    acceptedChildCompletionIds: [],
    causalRejectionIds: [],
    childCompletionRecorded: false,
  };
  for (const event of events) apply(state, event);
  return immutableView(state);
}

type Mutable = {
  workflowInstanceId: string;
  workItemId: WorkflowInstanceView['workItemId'];
  workflowName: string;
  orchestrationGroupId: string;
  parentWorkflowInstanceId?: string;
  watchId?: string;
  triggerId?: string;
  causalCycleId?: string;
  requestId?: string;
  status: WorkflowInstanceView['status'];
  currentStage: string;
  pendingActivation?: ActivityActivationView;
  repeatCounts: Record<string, number>;
  retryCounts: Record<string, number>;
  waitingFor?: WorkflowInstanceView['waitingFor'];
  supplementalQueue: {
    activity: string;
    input: unknown;
    requestedBy: string;
  }[];
  acceptedSignalIds: string[];
  acceptedOutcomes: string[];
  acceptedChildCompletionIds: string[];
  causalRejectionIds: string[];
  childCompletionRecorded: boolean;
  lastOutcome?: WorkflowInstanceView['lastOutcome'];
};

function apply(state: Mutable, event: WorkflowFact): void {
  if (isActivityFact(event)) {
    applyActivityFact(state, event);
    return;
  }
  if (isInteractionFact(event)) {
    applyInteractionFact(state, event);
    return;
  }
  if (isLifecycleFact(event)) {
    applyLifecycleFact(state, event);
    return;
  }
  applyCoordinationFact(state, event);
}

type FactsOf<Type extends WorkflowFact['eventType']> = Extract<
  WorkflowFact,
  { readonly eventType: Type }
>;
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

function applyActivityFact(state: Mutable, event: ActivityFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.StageEntered:
      state.currentStage = event.payload.stage;
      return;
    case OrchestrationEventType.ActivityRequested:
      applyActivityRequested(state, event.payload);
      return;
    case OrchestrationEventType.ActivityStarted:
      updateActivationStatus(state, event.payload.activationId, 'running');
      return;
    case OrchestrationEventType.ActivityOutcomeAccepted:
      state.acceptedOutcomes.push(event.payload.activationId);
      state.lastOutcome = event.payload.outcome;
      updateActivationStatus(state, event.payload.activationId, 'completed');
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

function applyInteractionFact(state: Mutable, event: InteractionFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.SignalWaitStarted:
      applySignalWaitStarted(state, event);
      return;
    case OrchestrationEventType.SignalAccepted:
      state.status = 'active';
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

function applyLifecycleFact(state: Mutable, event: LifecycleFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.RepeatCounted:
      state.repeatCounts[event.payload.routeId] = event.payload.count;
      return;
    case OrchestrationEventType.RetryCounted:
      state.retryCounts[event.payload.retryKey] = event.payload.count;
      return;
    case OrchestrationEventType.InstanceCompleted:
      state.status = 'completed';
      delete state.pendingActivation;
      delete state.waitingFor;
      return;
    case OrchestrationEventType.InstanceBlocked:
      state.status = 'blocked';
      return;
    case OrchestrationEventType.InstanceSuperseded:
      state.status = 'superseded';
      return;
    default:
      assertNever(event);
  }
}

function applyCoordinationFact(state: Mutable, event: CoordinationFact): void {
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
  state: Mutable,
  event: FactsOf<typeof OrchestrationEventType.ActivityWaiting>,
): void {
  state.status = 'waiting';
  state.waitingFor = {
    signalKind: event.payload.signalKind,
    intentEventId: event.payload.intentEventId,
  };
  state.lastOutcome = event.payload.outcome;
  updateActivationStatus(state, event.payload.activationId, 'waiting');
}

function applySignalWaitStarted(
  state: Mutable,
  event: FactsOf<typeof OrchestrationEventType.SignalWaitStarted>,
): void {
  state.status = 'waiting';
  state.waitingFor = {
    signalKind: event.payload.signalKind,
    ...(event.payload.resourceId === undefined ? {} : { resourceId: event.payload.resourceId }),
    ...(event.payload.revision === undefined ? {} : { revision: event.payload.revision }),
  };
}

function updateActivationStatus(
  state: Mutable,
  activationId: string,
  status: ActivityActivationView['status'],
): void {
  if (state.pendingActivation?.activationId === activationId) {
    state.pendingActivation = { ...state.pendingActivation, status };
  }
}

function applyActivityRequested(
  state: Mutable,
  payload: Extract<
    WorkflowFact,
    { eventType: typeof OrchestrationEventType.ActivityRequested }
  >['payload'],
): void {
  state.status = 'active';
  delete state.waitingFor;
  state.pendingActivation = {
    activationId: payload.activationId,
    ordinal: payload.ordinal,
    activity: payload.activity,
    input: payload.input,
    execution: payload.execution,
    status: 'pending',
    ...(payload.followOnIndex === undefined ? {} : { followOnIndex: payload.followOnIndex }),
    ...(payload.supplemental === true ? { supplemental: true } : {}),
  };
}

function immutableView(state: Mutable): WorkflowInstanceView {
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

function optionalChildFields(
  payload: Extract<
    WorkflowFact,
    { eventType: typeof OrchestrationEventType.InstanceStarted }
  >['payload'],
): Pick<
  Mutable,
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

function assertNever(value: never): never {
  throw new Error(`Unhandled WorkflowInstance event: ${JSON.stringify(value)}`);
}
