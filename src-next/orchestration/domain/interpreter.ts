import type { ActivityOutcome } from '../../activities/index.js';
import type { EventDraft } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { CompiledOutcomeRoute, CompiledWorkflow } from '../contracts/config.js';
import type {
  ChildCoordinationMetadata,
  OrchestrationSignal,
  SignalExpectation,
  SupplementalActivityRequest,
} from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { activation, nextOrdinal, startDraft, stateDraft } from './decision-events.js';
import { childStartDrafts } from './coordination-events.js';
import { finishRoute } from './transition.js';

export type OrchestrationDecision =
  | { readonly kind: 'append'; readonly events: readonly EventDraft[] }
  | { readonly kind: 'ignored'; readonly reason: string };

interface StartInstanceBase {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly orchestrationGroupId: string;
  readonly definition: CompiledWorkflow;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
}
type PrimaryInstanceStart = {
  readonly parentWorkflowInstanceId?: never;
  readonly watchId?: never;
  readonly triggerId?: never;
  readonly causalCycleId?: never;
  readonly requestId?: never;
};
type ChildInstanceStart = {
  readonly parentWorkflowInstanceId: string;
  readonly watchId: string;
  readonly triggerId: string;
  readonly causalCycleId: string;
  readonly requestId: string;
};
export type StartInstanceInput = StartInstanceBase & (PrimaryInstanceStart | ChildInstanceStart);

export interface DecisionContext {
  readonly occurredAt: string;
  readonly causationId: string;
}

export interface AcceptActivityOutcome extends DecisionContext {
  readonly activationId: string;
  readonly outcome: ActivityOutcome;
}

export interface AcceptSignal extends DecisionContext {
  readonly signal: OrchestrationSignal;
}

export interface QueueSupplementalActivity extends DecisionContext {
  readonly activity: string;
  readonly input: unknown;
  readonly requestedBy: string;
}

export function startInstance(input: StartInstanceInput): OrchestrationDecision {
  const stage = input.definition.stages[input.definition.entry]!;
  const child = childMetadata(input);
  const childEvents =
    child === undefined
      ? []
      : childStartDrafts(
          {
            workflowInstanceId: input.workflowInstanceId,
            eventIdPrefix: input.causationId,
            occurredAt: input.occurredAt,
            correlationId: input.correlationId,
            causationId: input.causationId,
          },
          child,
          input.definition.name,
        );
  return {
    kind: 'append',
    events: [
      ...childEvents,
      startDraft(
        input,
        'instance-started',
        {
          workItemId: input.workItemId,
          workflowName: input.definition.name,
          orchestrationGroupId: input.orchestrationGroupId,
          entry: input.definition.entry,
          ...child,
        },
        childEvents.length + 1,
      ),
      startDraft(input, 'stage-entered', { stage: input.definition.entry }, childEvents.length + 2),
      startDraft(
        input,
        'activity-requested',
        activation(input.workflowInstanceId, 1, stage.activity, stage.with, {
          execution: stage.execution,
        }),
        childEvents.length + 3,
      ),
    ],
  };
}

function childMetadata(input: StartInstanceInput): ChildCoordinationMetadata | undefined {
  if (input.parentWorkflowInstanceId === undefined) return undefined;
  return {
    parentWorkflowInstanceId: input.parentWorkflowInstanceId,
    watchId: input.watchId,
    triggerId: input.triggerId,
    orchestrationGroupId: input.orchestrationGroupId,
    causalCycleId: input.causalCycleId,
    requestId: input.requestId,
    childWorkflowInstanceId: input.workflowInstanceId,
  };
}

export function acceptActivityOutcome(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): OrchestrationDecision {
  if (!isPendingOutcome(state, input)) {
    return { kind: 'ignored', reason: 'outcome is not for the pending activation' };
  }
  const pending = state.pendingActivation!;

  const events: EventDraft[] = [
    stateDraft(
      state,
      input,
      'activity-outcome-accepted',
      { activationId: input.activationId, outcome: input.outcome },
      1,
    ),
  ];

  if (pending.supplemental === true) {
    finishSupplemental(events, definition, state, input);
    return { kind: 'append', events };
  }

  const route = definition.stages[state.currentStage]?.on[input.outcome.kind];
  if (route === undefined)
    return { kind: 'ignored', reason: `unconfigured outcome ${input.outcome.kind}` };

  if (input.outcome.kind !== 'done') {
    if (mayRetry(route, state, input.outcome)) {
      requestRetry(events, definition, state, input);
    } else {
      finishRoute(events, definition, state, input, route);
    }
    return { kind: 'append', events };
  }

  if (state.supplementalQueue.length > 0) {
    requestNextSupplemental(events, state, input);
    return { kind: 'append', events };
  }

  const followOns = route.activities ?? [];
  const nextFollowOnIndex = (pending.followOnIndex ?? -1) + 1;
  if (nextFollowOnIndex < followOns.length) {
    const next = followOns[nextFollowOnIndex]!;
    events.push(
      stateDraft(
        state,
        input,
        'activity-requested',
        activation(state.workflowInstanceId, pending.ordinal + 1, next.use, next.with, {
          execution: undefined,
          followOnIndex: nextFollowOnIndex,
        }),
        events.length + 1,
      ),
    );
    return { kind: 'append', events };
  }

  finishRoute(events, definition, state, input, route);
  return { kind: 'append', events };
}

function isPendingOutcome(state: WorkflowInstanceView, input: AcceptActivityOutcome): boolean {
  return (
    state.pendingActivation !== undefined &&
    state.pendingActivation.activationId === input.activationId &&
    !state.acceptedOutcomes.includes(input.activationId)
  );
}

export function waitForSignal(
  state: WorkflowInstanceView,
  expectation: SignalExpectation,
  input: DecisionContext,
): OrchestrationDecision {
  if (state.status !== 'waiting' && state.status !== 'blocked')
    return { kind: 'ignored', reason: 'WorkflowInstance is not waiting or blocked' };
  if (expectation.signalKind.trim().length === 0)
    return { kind: 'ignored', reason: 'signal kind must not be empty' };
  return {
    kind: 'append',
    events: [stateDraft(state, input, 'signal-wait-started', expectation, 1)],
  };
}

export function acceptSignal(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptSignal,
): OrchestrationDecision {
  const signal = input.signal;
  if (state.acceptedSignalIds.includes(signal.providerEventId))
    return { kind: 'ignored', reason: 'provider signal was already accepted' };
  const expected = state.waitingFor;
  if (state.status !== 'waiting' || expected === undefined)
    return { kind: 'ignored', reason: 'WorkflowInstance is not waiting for a signal' };
  if (
    signal.kind !== expected.signalKind ||
    signal.resourceId !== expected.resourceId ||
    signal.revision !== expected.revision
  ) {
    return { kind: 'ignored', reason: 'signal does not match the current expectation' };
  }
  if (
    signal.actorId.trim().length === 0 ||
    !signal.actorDecision.authorized ||
    signal.actorDecision.evidenceId.trim().length === 0
  ) {
    return { kind: 'ignored', reason: 'signal lacks authorized actor decision evidence' };
  }
  if (signal.providerEventId.trim().length === 0)
    return { kind: 'ignored', reason: 'signal lacks provider event identity' };

  const stage = definition.stages[state.currentStage]!;
  return {
    kind: 'append',
    events: [
      stateDraft(state, input, 'signal-accepted', signal, 1),
      stateDraft(
        state,
        input,
        'activity-requested',
        activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
          execution: stage.execution,
        }),
        2,
      ),
    ],
  };
}

export function requestSupplementalActivity(
  state: WorkflowInstanceView,
  request: Omit<QueueSupplementalActivity, keyof DecisionContext>,
  input: DecisionContext,
): OrchestrationDecision {
  if (state.status !== 'active' || state.pendingActivation === undefined)
    return { kind: 'ignored', reason: 'supplemental commands require an active WorkflowInstance' };
  return {
    kind: 'append',
    events: [
      stateDraft(
        state,
        input,
        'supplemental-activity-queued',
        {
          activity: request.activity,
          input: request.input,
          requestedBy: request.requestedBy,
        },
        1,
      ),
    ],
  };
}

function mayRetry(
  route: CompiledOutcomeRoute,
  state: WorkflowInstanceView,
  outcome: ActivityOutcome,
): boolean {
  if (route.retry === undefined || requiresReconciliation(outcome)) return false;
  const retryKey = `${state.currentStage}:${outcome.kind}`;
  return (state.retryCounts[retryKey] ?? 0) < route.retry.max;
}

function requiresReconciliation(outcome: ActivityOutcome): boolean {
  if (typeof outcome.data !== 'object' || outcome.data === null) return false;
  const retrySafety = (outcome.data as Record<string, unknown>).retrySafety;
  return retrySafety === 'requires-reconciliation' || retrySafety === 'REQUIRES_RECONCILIATION';
}

function requestRetry(
  events: EventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): void {
  const retryKey = `${state.currentStage}:${input.outcome.kind}`;
  const count = (state.retryCounts[retryKey] ?? 0) + 1;
  const stage = definition.stages[state.currentStage]!;
  events.push(
    stateDraft(state, input, 'retry-counted', { retryKey, count }, events.length + 1),
    stateDraft(
      state,
      input,
      'activity-requested',
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
      }),
      events.length + 2,
    ),
  );
}

function finishSupplemental(
  events: EventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): void {
  if (input.outcome.kind !== 'done') {
    events.push(
      stateDraft(
        state,
        input,
        'instance-blocked',
        { reason: `supplemental activity returned ${input.outcome.kind}` },
        events.length + 1,
      ),
    );
    return;
  }
  if (state.supplementalQueue.length > 0) {
    requestNextSupplemental(events, state, input);
    return;
  }
  const stage = definition.stages[state.currentStage]!;
  events.push(
    stateDraft(
      state,
      input,
      'activity-requested',
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
      }),
      events.length + 1,
    ),
  );
}

function requestNextSupplemental(
  events: EventDraft[],
  state: WorkflowInstanceView,
  input: DecisionContext,
): void {
  const next = state.supplementalQueue[0]!;
  events.push(
    stateDraft(
      state,
      input,
      'supplemental-activity-dequeued',
      { activity: next.activity, requestedBy: next.requestedBy },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      'activity-requested',
      activation(state.workflowInstanceId, nextOrdinal(state), next.activity, next.input, {
        execution: undefined,
        supplemental: true,
      }),
      events.length + 2,
    ),
  );
}

export type { SupplementalActivityRequest };
