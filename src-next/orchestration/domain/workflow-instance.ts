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
    status: 'active',
    currentStage: String(first.payload.entry),
    repeatCounts: {},
    acceptedOutcomes: [],
  };
  for (const event of events) apply(state, event);
  return {
    workflowInstanceId: state.workflowInstanceId,
    workItemId: state.workItemId,
    workflowName: state.workflowName,
    orchestrationGroupId: state.orchestrationGroupId,
    status: state.status,
    currentStage: state.currentStage,
    repeatCounts: state.repeatCounts,
    acceptedOutcomes: state.acceptedOutcomes,
    ...(state.pendingActivation === undefined
      ? {}
      : { pendingActivation: state.pendingActivation }),
    ...(state.lastOutcome === undefined ? {} : { lastOutcome: state.lastOutcome }),
  };
}
type Mutable = {
  workflowInstanceId: string;
  workItemId: ReturnType<typeof workItemId>;
  workflowName: string;
  orchestrationGroupId: string;
  status: WorkflowInstanceView['status'];
  currentStage: string;
  pendingActivation?: ActivityActivationView;
  repeatCounts: Record<string, number>;
  acceptedOutcomes: string[];
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
}
function applyStatus(state: Mutable, eventType: string, payload: Record<string, unknown>): void {
  if (eventType === 'orchestration.signal-wait-started') state.status = 'waiting';
  if (eventType === 'orchestration.repeat-counted')
    state.repeatCounts[String(payload.routeId)] = Number(payload.count);
  if (eventType === 'orchestration.instance-completed') {
    state.status = 'completed';
    delete state.pendingActivation;
  }
  if (eventType === 'orchestration.instance-blocked') state.status = 'blocked';
  if (eventType === 'orchestration.instance-superseded') state.status = 'superseded';
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
