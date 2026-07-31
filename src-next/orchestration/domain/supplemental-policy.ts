import { ActivityOutcomeKind } from '../../activities/index.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type {
  SupplementalActivityRequest,
  WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
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
        OrchestrationEventType.SupplementalActivityQueued,
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

export function finishSupplemental(
  events: WorkflowOrchestrationEventDraft[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): void {
  if (input.outcome.kind !== ActivityOutcomeKind.Done) {
    events.push(
      stateDraft(
        state,
        input,
        OrchestrationEventType.InstanceBlocked,
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
  const stage = definition.stages[stageName(state.currentStage)]!;
  events.push(
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
      }),
      events.length + 1,
    ),
  );
}

export function requestNextSupplemental(
  events: WorkflowOrchestrationEventDraft[],
  state: WorkflowInstanceView,
  input: DecisionContext,
): void {
  const next = state.supplementalQueue[0]!;
  events.push(
    stateDraft(
      state,
      input,
      OrchestrationEventType.SupplementalActivityDequeued,
      { activity: next.activity, requestedBy: next.requestedBy },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), next.activity, next.input, {
        execution: undefined,
        supplemental: true,
      }),
      events.length + 2,
    ),
  );
}

export type { SupplementalActivityRequest };
