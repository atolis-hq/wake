/* eslint-disable max-lines */

import type { ActivationId } from '../../activities/index.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEventData,
} from '../contracts/events.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';
import { ActivityActivationStatus, WorkflowStatus } from '../contracts/vocabulary.js';

type WorkflowFact = WorkflowOrchestrationEventData;

/**
 * The single source of truth for which orchestration events change a
 * workflow instance's status, and to what — every other consumer that needs
 * to reflect status externally (GitHub labels, the operator board, delivery
 * reactors) must derive from this table rather than hand-matching event
 * types itself, or it silently falls out of sync whenever a new
 * status-changing event type is introduced here.
 */
export const orchestrationStatusTransitions: Readonly<
  Partial<Record<WorkflowFact['eventType'], WorkflowInstanceView['status']>>
> = {
  [OrchestrationEventType.ActivityRequested]: WorkflowStatus.Active,
  [OrchestrationEventType.DelegationWaitStarted]: WorkflowStatus.Waiting,
  [OrchestrationEventType.ActivityWaiting]: WorkflowStatus.Waiting,
  [OrchestrationEventType.SignalWaitStarted]: WorkflowStatus.Waiting,
  [OrchestrationEventType.SignalAccepted]: WorkflowStatus.Active,
  [OrchestrationEventType.InstanceCompleted]: WorkflowStatus.Completed,
  [OrchestrationEventType.InstanceBlocked]: WorkflowStatus.Blocked,
  [OrchestrationEventType.InstanceSuperseded]: WorkflowStatus.Superseded,
};

type FactsOf<Type extends WorkflowFact['eventType']> = Extract<
  WorkflowFact,
  { readonly eventType: Type }
>;

export type MutableWorkflowInstance = {
  workflowInstanceId: WorkflowInstanceView['workflowInstanceId'];
  workItemId: WorkflowInstanceView['workItemId'];
  workflowName: WorkflowInstanceView['workflowName'];
  workflowDefinitionFingerprint?: string;
  orchestrationGroupId: WorkflowInstanceView['orchestrationGroupId'];
  parentWorkflowInstanceId?: WorkflowInstanceView['parentWorkflowInstanceId'];
  watchId?: string;
  triggerId?: string;
  causalCycleId?: string;
  requestId?: string;
  delegationFence?: WorkflowInstanceView['delegationFence'];
  delegationWait?: WorkflowInstanceView['delegationWait'];
  delegationAttention?: WorkflowInstanceView['delegationAttention'];
  status: WorkflowInstanceView['status'];
  blockReason?: string;
  currentStage: WorkflowInstanceView['currentStage'];
  pendingActivation?: ActivityActivationView;
  repeatCounts: Record<string, number>;
  retryCounts: Record<string, number>;
  waitingFor?: WorkflowInstanceView['waitingFor'];
  supplementalQueue: Array<WorkflowInstanceView['supplementalQueue'][number]>;
  acceptedSignalIds: string[];
  operatorRetryCommandIds: string[];
  hasStartedActivation: boolean;
  acceptedOutcomes: ActivationId[];
  acceptedChildCompletionIds: WorkflowInstanceView['workflowInstanceId'][];
  causalRejectionIds: string[];
  childCompletionRecorded: boolean;
  lastOutcome?: WorkflowInstanceView['lastOutcome'];
  executionFailure?: WorkflowInstanceView['executionFailure'];
};

type ActivityFact = FactsOf<
  | typeof OrchestrationEventType.StageEntered
  | typeof OrchestrationEventType.ActivityRequested
  | typeof OrchestrationEventType.ActivityStarted
  | typeof OrchestrationEventType.ActivityOutcomeAccepted
  | typeof OrchestrationEventType.ActivityExecutionFailed
  | typeof OrchestrationEventType.ActivityRetriedForRunnerQuota
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
  | typeof OrchestrationEventType.OperatorRetryRequested
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
    case OrchestrationEventType.ActivityExecutionFailed:
    case OrchestrationEventType.ActivityRetriedForRunnerQuota:
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
      state.hasStartedActivation = true;
      updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Running);
      return;
    case OrchestrationEventType.ActivityOutcomeAccepted:
      state.acceptedOutcomes.push(event.payload.activationId);
      state.lastOutcome = event.payload.outcome;
      updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Completed);
      return;
    case OrchestrationEventType.ActivityExecutionFailed:
      state.acceptedOutcomes.push(event.payload.activationId);
      state.executionFailure = event.payload;
      updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Completed);
      return;
    case OrchestrationEventType.ActivityRetriedForRunnerQuota:
      state.acceptedOutcomes.push(event.payload.activationId);
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
      state.status = orchestrationStatusTransitions[OrchestrationEventType.SignalAccepted]!;
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
    case OrchestrationEventType.OperatorRetryRequested:
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
      delete state.delegationWait;
      delete state.delegationAttention;
      state.status = orchestrationStatusTransitions[OrchestrationEventType.InstanceCompleted]!;
      delete state.pendingActivation;
      delete state.waitingFor;
      return;
    case OrchestrationEventType.InstanceBlocked:
      delete state.delegationWait;
      delete state.delegationAttention;
      state.status = orchestrationStatusTransitions[OrchestrationEventType.InstanceBlocked]!;
      state.blockReason = event.payload.reason;
      return;
    case OrchestrationEventType.OperatorRetryRequested:
      state.operatorRetryCommandIds.push(event.payload.commandId);
      return;
    case OrchestrationEventType.InstanceSuperseded:
      delete state.delegationWait;
      delete state.delegationAttention;
      state.status = orchestrationStatusTransitions[OrchestrationEventType.InstanceSuperseded]!;
      return;
    default:
      assertNever(event);
  }
}

function applyDelegationFact(
  state: MutableWorkflowInstance,
  event: FactsOf<
    | typeof OrchestrationEventType.DelegationWaitStarted
    | typeof OrchestrationEventType.DelegationJoined
  >,
): void {
  if (event.eventType === OrchestrationEventType.DelegationJoined) {
    delete state.delegationWait;
    delete state.delegationAttention;
    delete state.delegationFence;
    return;
  }
  state.delegationWait = event.payload;
  state.status = WorkflowStatus.Waiting;
}

// Exhaustive dispatch over the closed coordination event set.
// eslint-disable-next-line complexity
function applyCoordinationFact(state: MutableWorkflowInstance, event: CoordinationFact): void {
  switch (event.eventType) {
    case OrchestrationEventType.InstanceStarted:
    case OrchestrationEventType.ChildRequested:
    case OrchestrationEventType.ChildStarted:
    case OrchestrationEventType.GroupBudgetExhausted:
    case OrchestrationEventType.DelegationFailed:
      delete state.delegationFence;
      delete state.delegationAttention;
      return;
    case OrchestrationEventType.DelegationAttentionRequested:
      state.delegationAttention = {
        cohortId: event.payload.cohortId,
        attentionKey: event.payload.attentionKey,
        activationId: event.payload.activationId,
      };
      return;
    case OrchestrationEventType.DelegationAttentionResolved:
      // The assessment is not an outcome route: the unresolved cohort wait is simply restored.
      if (state.delegationAttention?.attentionKey !== event.payload.attentionKey) return;
      delete state.delegationAttention;
      state.acceptedOutcomes.push(event.payload.activationId);
      updateActivationStatus(state, event.payload.activationId, ActivityActivationStatus.Completed);
      if (state.delegationWait !== undefined) state.status = WorkflowStatus.Waiting;
      return;
    case OrchestrationEventType.DelegationAttentionResponded:
      return;
    case OrchestrationEventType.DelegationReconciliationFailed:
    case OrchestrationEventType.SignalDeferred:
      return;
    case OrchestrationEventType.DelegationReserved:
      if (event.payload.parentWorkflowInstanceId === state.workflowInstanceId)
        state.delegationFence = {
          cohortId: event.payload.cohortId,
          activationId: event.payload.activationId,
        };
      return;
    case OrchestrationEventType.DelegationRegistered:
    case OrchestrationEventType.DelegationInputsResolved:
    case OrchestrationEventType.DelegationPrerequisiteBlocked:
    case OrchestrationEventType.DelegationChildBlocked:
    case OrchestrationEventType.DelegationResultSelected:
      return;
    case OrchestrationEventType.DelegationWaitStarted:
    case OrchestrationEventType.DelegationJoined:
      return applyDelegationFact(state, event);
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
  state.status = orchestrationStatusTransitions[OrchestrationEventType.ActivityWaiting]!;
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
  state.status = orchestrationStatusTransitions[OrchestrationEventType.SignalWaitStarted]!;
  state.waitingFor = {
    signalKind: event.payload.signalKind,
    ...(event.payload.timeoutMs === undefined ? {} : { timeoutMs: event.payload.timeoutMs }),
    ...(event.payload.waitStartedAt === undefined
      ? {}
      : { waitStartedAt: event.payload.waitStartedAt }),
    ...(event.payload.suppressWatchDispatch === true ? { suppressWatchDispatch: true } : {}),
    ...(event.payload.resourceId === undefined ? {} : { resourceId: event.payload.resourceId }),
    ...(event.payload.revision === undefined ? {} : { revision: event.payload.revision }),
    ...(event.payload.from === undefined ? {} : { from: event.payload.from }),
    ...(event.payload.resume === undefined ? {} : { resume: event.payload.resume }),
    ...(event.payload.onRejectResume === undefined
      ? {}
      : { onRejectResume: event.payload.onRejectResume }),
    ...(event.payload.resourceTransitions === undefined
      ? {}
      : { resourceTransitions: event.payload.resourceTransitions }),
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
  state.status = orchestrationStatusTransitions[OrchestrationEventType.ActivityRequested]!;
  delete state.waitingFor;
  state.pendingActivation = {
    ...(payload.notBefore === undefined ? {} : { notBefore: payload.notBefore }),
    activationId: payload.activationId,
    ordinal: payload.ordinal,
    activity: payload.activity,
    ...(payload.stage === undefined ? {} : { stage: payload.stage }),
    input: payload.input,
    execution: payload.execution,
    ...(payload.sessionPolicy === undefined ? {} : { sessionPolicy: payload.sessionPolicy }),
    status: ActivityActivationStatus.Pending,
    ...(payload.followOnIndex === undefined ? {} : { followOnIndex: payload.followOnIndex }),
    ...(payload.supplemental === true ? { supplemental: true } : {}),
    ...(payload.watchDriven === true ? { watchDriven: true as const } : {}),
  };
}

// One optional-field projection per view property; branching mirrors the view shape.
// eslint-disable-next-line complexity
export function immutableWorkflowInstanceView(
  state: MutableWorkflowInstance,
): WorkflowInstanceView {
  return {
    workflowInstanceId: state.workflowInstanceId,
    workItemId: state.workItemId,
    workflowName: state.workflowName,
    ...(state.workflowDefinitionFingerprint === undefined
      ? {}
      : { workflowDefinitionFingerprint: state.workflowDefinitionFingerprint }),
    orchestrationGroupId: state.orchestrationGroupId,
    ...(state.parentWorkflowInstanceId === undefined
      ? {}
      : { parentWorkflowInstanceId: state.parentWorkflowInstanceId }),
    ...(state.watchId === undefined ? {} : { watchId: state.watchId }),
    ...(state.triggerId === undefined ? {} : { triggerId: state.triggerId }),
    ...(state.causalCycleId === undefined ? {} : { causalCycleId: state.causalCycleId }),
    ...(state.requestId === undefined ? {} : { requestId: state.requestId }),
    ...(state.delegationFence === undefined ? {} : { delegationFence: state.delegationFence }),
    ...(state.delegationWait === undefined ? {} : { delegationWait: state.delegationWait }),
    ...(state.delegationAttention === undefined
      ? {}
      : { delegationAttention: state.delegationAttention }),
    status: state.status,
    ...(state.blockReason === undefined ? {} : { blockReason: state.blockReason }),
    currentStage: state.currentStage,
    repeatCounts: state.repeatCounts,
    retryCounts: state.retryCounts,
    supplementalQueue: state.supplementalQueue,
    acceptedSignalIds: state.acceptedSignalIds,
    operatorRetryCommandIds: state.operatorRetryCommandIds,
    hasStartedActivation: state.hasStartedActivation,
    acceptedOutcomes: state.acceptedOutcomes,
    acceptedChildCompletionIds: state.acceptedChildCompletionIds,
    causalRejectionIds: state.causalRejectionIds,
    childCompletionRecorded: state.childCompletionRecorded,
    ...(state.pendingActivation === undefined
      ? {}
      : { pendingActivation: state.pendingActivation }),
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
    ...(state.executionFailure === undefined ? {} : { executionFailure: state.executionFailure }),
    ...(state.waitingFor === undefined ? {} : { waitingFor: state.waitingFor }),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WorkflowInstance event: ${JSON.stringify(value)}`);
}
