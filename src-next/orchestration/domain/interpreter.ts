import type { ActivityOutcome } from '../../activities/index.js';
import { createEventDraft, entityRef, type EventDraft } from '../../kernel/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { CompiledOutcomeRoute, CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowInstanceView } from '../contracts/views.js';

export type OrchestrationDecision =
  | { readonly kind: 'append'; readonly events: readonly EventDraft[] }
  | { readonly kind: 'ignored'; readonly reason: string };
export interface StartInstanceInput {
  readonly workflowInstanceId: string;
  readonly workItemId: WorkItemId;
  readonly orchestrationGroupId: string;
  readonly definition: CompiledWorkflow;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly causationId: string;
}
export interface AcceptActivityOutcome {
  readonly activationId: string;
  readonly outcome: ActivityOutcome;
  readonly occurredAt: string;
  readonly causationId: string;
}
const actor = { kind: 'system' as const, id: 'orchestration' };
const source = { kind: 'internal' as const, id: 'orchestration' };

export function startInstance(input: StartInstanceInput): OrchestrationDecision {
  const stage = input.definition.stages[input.definition.entry]!;
  return {
    kind: 'append',
    events: [
      draft(
        input,
        'instance-started',
        {
          workItemId: input.workItemId,
          workflowName: input.definition.name,
          orchestrationGroupId: input.orchestrationGroupId,
          entry: input.definition.entry,
        },
        1,
      ),
      draft(input, 'stage-entered', { stage: input.definition.entry }, 2),
      draft(
        input,
        'activity-requested',
        activation(input.workflowInstanceId, 1, stage.activity, stage.with, {
          execution: stage.execution,
        }),
        3,
      ),
    ],
  };
}

export function acceptActivityOutcome(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): OrchestrationDecision {
  const pending = state.pendingActivation;
  if (
    pending === undefined ||
    pending.activationId !== input.activationId ||
    state.acceptedOutcomes.includes(input.activationId)
  )
    return { kind: 'ignored', reason: 'outcome is not for the pending activation' };
  const route = definition.stages[state.currentStage]?.on[input.outcome.kind];
  if (route === undefined)
    return { kind: 'ignored', reason: `unconfigured outcome ${input.outcome.kind}` };
  const events: EventDraft[] = [
    stateDraft(
      state,
      input,
      'activity-outcome-accepted',
      { activationId: input.activationId, outcome: input.outcome },
      1,
    ),
  ];
  if (input.outcome.kind !== 'done') {
    if (route.then === 'await-human')
      events.push(
        stateDraft(state, input, 'signal-wait-started', { signalKind: input.outcome.kind }, 2),
      );
    else
      events.push(stateDraft(state, input, 'instance-blocked', { reason: input.outcome.kind }, 2));
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
        2,
      ),
    );
    return { kind: 'append', events };
  }
  finishRoute(events, definition, state, input, route);
  return { kind: 'append', events };
}

function finishRoute(
  events: EventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
  route: CompiledOutcomeRoute,
): void {
  if (route.then === 'done') {
    events.push(stateDraft(state, input, 'instance-completed', {}, events.length + 1));
    return;
  }
  if (route.then === 'await-human') {
    events.push(stateDraft(state, input, 'signal-wait-started', {}, events.length + 1));
    return;
  }
  const count = (state.repeatCounts[route.id] ?? 0) + 1;
  if (route.repeat !== undefined) {
    if (count > route.repeat.max) {
      events.push(
        stateDraft(
          state,
          input,
          'instance-blocked',
          { reason: `repeat.max exceeded for ${route.id}` },
          events.length + 1,
        ),
      );
      return;
    }
    events.push(
      stateDraft(state, input, 'repeat-counted', { routeId: route.id, count }, events.length + 1),
    );
  }
  const stage = definition.stages[route.then]!;
  events.push(stateDraft(state, input, 'stage-entered', { stage: route.then }, events.length + 1));
  events.push(
    stateDraft(
      state,
      input,
      'activity-requested',
      activation(
        state.workflowInstanceId,
        state.pendingActivation!.ordinal + 1,
        stage.activity,
        stage.with,
        { execution: stage.execution },
      ),
      events.length + 1,
    ),
  );
}
function activation(
  id: string,
  ordinal: number,
  activity: string,
  input: unknown,
  options: { readonly execution: unknown; readonly followOnIndex?: number },
) {
  return {
    activationId: `${id}:activity:${ordinal}`,
    ordinal,
    activity,
    input,
    execution: options.execution,
    ...(options.followOnIndex === undefined ? {} : { followOnIndex: options.followOnIndex }),
  };
}
function draft(
  input: StartInstanceInput,
  suffix: string,
  payload: unknown,
  ordinal: number,
): EventDraft {
  return createEventDraft({
    eventId: `${input.causationId}:orchestration.${suffix}:${ordinal}`,
    eventType: `orchestration.${suffix}`,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    actor,
    source,
    stream: entityRef('workflow-instance', input.workflowInstanceId),
    payload,
  });
}
function stateDraft(
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
  suffix: string,
  payload: unknown,
  ordinal: number,
): EventDraft {
  return createEventDraft({
    eventId: `${input.causationId}:orchestration.${suffix}:${ordinal}`,
    eventType: `orchestration.${suffix}`,
    occurredAt: input.occurredAt,
    correlationId: state.orchestrationGroupId,
    causationId: input.causationId,
    actor,
    source,
    stream: entityRef('workflow-instance', state.workflowInstanceId),
    payload,
  });
}
export function acceptSignal(): OrchestrationDecision {
  return { kind: 'ignored', reason: 'signal handling is not configured' };
}
