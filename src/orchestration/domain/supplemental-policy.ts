import { EventActorKind, type EventActor } from '@atolis-hq/eventing';
import { ActivityOutcomeKind } from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type {
  SupplementalActivityRequest,
  WorkflowOrchestrationEventData,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ApprovalAuthorityKind, WorkflowStatus } from '../contracts/vocabulary.js';
import type {
  AcceptActivityOutcome,
  DecisionContext,
  OrchestrationDecision,
  QueueSupplementalActivity,
} from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

export function requestSupplementalActivity(
  state: WorkflowInstanceView,
  request: Omit<QueueSupplementalActivity, keyof DecisionContext>,
  input: DecisionContext,
): OrchestrationDecision {
  if (state.status !== WorkflowStatus.Active || state.pendingActivation === undefined)
    return { kind: 'ignored', reason: 'supplemental commands require an active WorkflowInstance' };
  return {
    kind: 'append',
    events: [
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.SupplementalActivityQueued,
          payload: {
            activity: request.activity,
            input: request.input,
            requestedBy: request.requestedBy,
          },
        },
        1,
      ),
    ],
  };
}

export function finishSupplemental(
  events: WorkflowOrchestrationEventData[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): void {
  if (input.outcome.kind !== ActivityOutcomeKind.Done) {
    events.push(
      stateDraft(
        state,
        input,
        {
          eventType: OrchestrationEventType.InstanceBlocked,
          payload: { reason: `supplemental activity returned ${input.outcome.kind}` },
        },
        events.length + 1,
      ),
    );
    return;
  }
  if (state.supplementalQueue.length > 0) {
    requestNextSupplemental(events, state, input);
    return;
  }
  const stage = definition.stages[stageName(state.currentStage)]!;
  events.push(
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.ActivityRequested,
        payload: activation(
          state.workflowInstanceId,
          nextOrdinal(state),
          stage.activity,
          stage.with,
          {
            execution: stage.execution,
            stage: stageName(state.currentStage),
          },
        ),
      },
      events.length + 1,
    ),
  );
}

export function requestNextSupplemental(
  events: WorkflowOrchestrationEventData[],
  state: WorkflowInstanceView,
  input: DecisionContext,
): void {
  const next = state.supplementalQueue[0]!;
  events.push(
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.SupplementalActivityDequeued,
        payload: { activity: next.activity, requestedBy: next.requestedBy },
      },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.ActivityRequested,
        payload: activation(
          state.workflowInstanceId,
          nextOrdinal(state),
          next.activity,
          next.input,
          {
            execution: undefined,
            supplemental: true,
          },
        ),
      },
      events.length + 2,
    ),
  );
}

// A command's `allowedActors` declares acceptance authority (ORCH-APPROVAL-AUTHORITY), not
// event provenance, so the invoking actor's provenance is resolved to an authority first.
export function isAuthorisedActor(
  allowed: readonly ApprovalAuthorityKind[],
  actorKind: EventActor['kind'],
): boolean {
  const authority = actorAuthority(actorKind);
  return authority !== null && allowed.includes(authority);
}

// Provenance answers who emitted the event; authority answers who may invoke. A provider
// relays a person typing in a ticket comment, which D16 counts as `human` on any surface.
// `auto` is never inferred from transport: it requires operator consent, so granting it
// from an actor kind would escalate authority without one.
function actorAuthority(actorKind: EventActor['kind']): ApprovalAuthorityKind | null {
  switch (actorKind) {
    case EventActorKind.Operator:
    case EventActorKind.Integration:
      return ApprovalAuthorityKind.Human;
    default:
      return null;
  }
}

export type { SupplementalActivityRequest };
