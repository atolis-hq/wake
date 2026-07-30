import type { EventDraft, EventEnvelope } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';

type Fact = EventDraft<string, unknown> | EventEnvelope<string, unknown>;
export function foldWorkflowInstance(events: readonly Fact[]): WorkflowInstanceView | null {
  const first = events.find((event) => event.eventType === 'orchestration.instance-started');
  if (first === undefined || !record(first.payload)) return null;
  const state: Mutable = {
    workflowInstanceId: first.stream.id,
    workItemId: workItemId(String(first.payload.workItemId)),
    workflowName: String(first.payload.workflowName),
    orchestrationGroupId: String(first.payload.orchestrationGroupId),
    ...optionalChildFields(first.payload),
    status: 'active',
    currentStage: String(first.payload.entry),
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
type Mutable = {
  workflowInstanceId: string;
  workItemId: ReturnType<typeof workItemId>;
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
function apply(state: Mutable, event: Fact): void {
  const payload = record(event.payload) ? event.payload : {};
  if (event.eventType === 'orchestration.stage-entered') state.currentStage = String(payload.stage);
  applyActivity(state, event.eventType, payload);
  applyStatus(state, event.eventType, payload);
}
function applyActivity(state: Mutable, eventType: string, payload: Record<string, unknown>): void {
  if (eventType === 'orchestration.activity-requested') {
    state.status = 'active';
    delete state.waitingFor;
    state.pendingActivation = {
      activationId: String(payload.activationId),
      ordinal: Number(payload.ordinal),
      activity: String(payload.activity),
      input: payload.input,
      execution: payload.execution as ActivityActivationView['execution'],
      status: 'pending',
      ...(typeof payload.followOnIndex === 'number'
        ? { followOnIndex: payload.followOnIndex }
        : {}),
      ...(payload.supplemental === true ? { supplemental: true } : {}),
    };
  }
  if (
    eventType === 'orchestration.activity-started' &&
    state.pendingActivation?.activationId === payload.activationId
  ) {
    const pending = state.pendingActivation as ActivityActivationView;
    state.pendingActivation = { ...pending, status: 'running' };
  }
  if (eventType === 'orchestration.activity-outcome-accepted') {
    state.acceptedOutcomes.push(String(payload.activationId));
    state.lastOutcome = payload.outcome as WorkflowInstanceView['lastOutcome'];
    if (state.pendingActivation?.activationId === payload.activationId) {
      const pending = state.pendingActivation as ActivityActivationView;
      state.pendingActivation = { ...pending, status: 'completed' };
    }
  }
  applyActivityWaiting(state, eventType, payload);
}
function applyActivityWaiting(
  state: Mutable,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (
    eventType === 'orchestration.activity-waiting' &&
    state.pendingActivation?.activationId === payload.activationId
  ) {
    const pending = state.pendingActivation as ActivityActivationView;
    state.pendingActivation = { ...pending, status: 'waiting' };
    state.lastOutcome = payload.outcome as WorkflowInstanceView['lastOutcome'];
  }
}
function applyStatus(state: Mutable, eventType: string, payload: Record<string, unknown>): void {
  applySignalStatus(state, eventType, payload);
  applyCoordinationStatus(state, eventType, payload);
  applyCountersAndQueue(state, eventType, payload);
  applyLifecycleStatus(state, eventType);
}

function applySignalStatus(
  state: Mutable,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (eventType === 'orchestration.signal-wait-started') {
    state.status = 'waiting';
    state.waitingFor = {
      signalKind: String(payload.signalKind),
      ...(typeof payload.resourceId === 'string' ? { resourceId: payload.resourceId } : {}),
      ...(typeof payload.revision === 'string' ? { revision: payload.revision } : {}),
    };
  }
  if (eventType === 'orchestration.activity-waiting') {
    state.status = 'waiting';
    state.waitingFor = {
      signalKind: String(payload.signalKind),
      intentEventId: String(payload.intentEventId),
    };
  }
  if (eventType === 'orchestration.signal-accepted') {
    state.status = 'active';
    state.acceptedSignalIds.push(String(payload.providerEventId));
    delete state.waitingFor;
  }
}

function applyCoordinationStatus(
  state: Mutable,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (eventType === 'orchestration.child-completion-consumed')
    state.acceptedChildCompletionIds.push(String(payload.childWorkflowInstanceId));
  if (eventType === 'orchestration.causal-activation-rejected')
    state.causalRejectionIds.push(String(payload.triggerId));
  if (eventType === 'orchestration.child-completed') state.childCompletionRecorded = true;
}

function applyCountersAndQueue(
  state: Mutable,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  if (eventType === 'orchestration.repeat-counted')
    state.repeatCounts[String(payload.routeId)] = Number(payload.count);
  if (eventType === 'orchestration.retry-counted')
    state.retryCounts[String(payload.retryKey)] = Number(payload.count);
  if (eventType === 'orchestration.supplemental-activity-queued')
    state.supplementalQueue.push({
      activity: String(payload.activity),
      input: payload.input,
      requestedBy: String(payload.requestedBy),
    });
  if (eventType === 'orchestration.supplemental-activity-dequeued') state.supplementalQueue.shift();
}

function applyLifecycleStatus(state: Mutable, eventType: string): void {
  if (eventType === 'orchestration.instance-completed') {
    state.status = 'completed';
    delete state.pendingActivation;
    delete state.waitingFor;
  }
  if (eventType === 'orchestration.instance-blocked') state.status = 'blocked';
  if (eventType === 'orchestration.instance-superseded') state.status = 'superseded';
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

function optionalChildFields(payload: Record<string, unknown>) {
  const parentWorkflowInstanceId = stringOrUndefined(payload.parentWorkflowInstanceId);
  const watchId = stringOrUndefined(payload.watchId);
  const triggerId = stringOrUndefined(payload.triggerId);
  const causalCycleId = stringOrUndefined(payload.causalCycleId);
  const requestId = stringOrUndefined(payload.requestId);
  if (
    parentWorkflowInstanceId === undefined ||
    watchId === undefined ||
    triggerId === undefined ||
    causalCycleId === undefined ||
    requestId === undefined
  )
    return {};
  return { parentWorkflowInstanceId, watchId, triggerId, causalCycleId, requestId };
}
