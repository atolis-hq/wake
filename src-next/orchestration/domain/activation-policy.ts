import type { ActivationId, ActivityName } from '../../activities/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { OrchestrationActivityOutcome } from '../contracts/activity-outcome.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import type { OrchestrationGroupId, WorkflowInstanceId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { childStartMetadata } from './child-policy.js';
import { childStartDrafts } from './coordination-events.js';
import { activation, startDraft, stateDraft } from './decision-events.js';

export type OrchestrationDecision =
  | { readonly kind: 'append'; readonly events: readonly WorkflowOrchestrationEventDraft[] }
  | { readonly kind: 'ignored'; readonly reason: string };

interface StartInstanceBase {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly workItemId: WorkItemId;
  readonly orchestrationGroupId: OrchestrationGroupId;
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
  readonly parentWorkflowInstanceId: WorkflowInstanceId;
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
  readonly activationId: ActivationId;
  readonly outcome: OrchestrationActivityOutcome;
}

export interface QueueSupplementalActivity extends DecisionContext {
  readonly activity: ActivityName;
  readonly input: unknown;
  readonly requestedBy: string;
}

export function startInstance(input: StartInstanceInput): OrchestrationDecision {
  const stage = input.definition.stages[input.definition.entry]!;
  const child = childStartMetadata(input);
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
        OrchestrationEventType.InstanceStarted,
        {
          workItemId: input.workItemId,
          workflowName: input.definition.name,
          orchestrationGroupId: input.orchestrationGroupId,
          entry: input.definition.entry,
          ...child,
        },
        childEvents.length + 1,
      ),
      startDraft(
        input,
        OrchestrationEventType.StageEntered,
        { stage: input.definition.entry },
        childEvents.length + 2,
      ),
      startDraft(
        input,
        OrchestrationEventType.ActivityRequested,
        activation(input.workflowInstanceId, 1, stage.activity, stage.with, {
          execution: stage.execution,
        }),
        childEvents.length + 3,
      ),
    ],
  };
}

export function isPendingOutcome(
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): boolean {
  return (
    state.pendingActivation !== undefined &&
    state.pendingActivation.activationId === input.activationId &&
    !state.acceptedOutcomes.includes(input.activationId)
  );
}

export function acceptOutcomeDraft(
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): WorkflowOrchestrationEventDraft {
  return stateDraft(
    state,
    input,
    OrchestrationEventType.ActivityOutcomeAccepted,
    { activationId: input.activationId, outcome: input.outcome },
    1,
  );
}

export function requestFollowOn(
  events: WorkflowOrchestrationEventDraft[],
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
  activities: readonly { readonly use: ActivityName; readonly with: unknown }[],
): boolean {
  const pending = state.pendingActivation!;
  const nextFollowOnIndex = (pending.followOnIndex ?? -1) + 1;
  if (nextFollowOnIndex >= activities.length) return false;
  const next = activities[nextFollowOnIndex]!;
  events.push(
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, pending.ordinal + 1, next.use, next.with, {
        execution: undefined,
        followOnIndex: nextFollowOnIndex,
      }),
      events.length + 1,
    ),
  );
  return true;
}
