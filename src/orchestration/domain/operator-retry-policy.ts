import { ActivityOutcomeKind } from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { ActivityActivationStatus, WorkflowStatus } from '../contracts/vocabulary.js';
import type { DecisionContext, OrchestrationDecision } from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

export interface OperatorRetryRequest extends DecisionContext {
  readonly commandId: string;
}

export function isOperatorRetryEligible(view: WorkflowInstanceView): boolean {
  const pending = view.pendingActivation;
  return (
    view.status === WorkflowStatus.Blocked &&
    view.blockReason === 'unconfigured outcome failed' &&
    pending !== undefined &&
    pending.status === ActivityActivationStatus.Completed &&
    pending.supplemental !== true &&
    pending.followOnIndex === undefined &&
    view.lastOutcome?.kind === ActivityOutcomeKind.Failed &&
    view.acceptedOutcomes.includes(pending.activationId)
  );
}

export function requestOperatorRetry(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: OperatorRetryRequest,
): OrchestrationDecision {
  if (input.commandId.length === 0)
    return { kind: 'ignored', reason: 'operator retry command id is required' };
  if (!isOperatorRetryEligible(state))
    return {
      kind: 'ignored',
      reason: 'workflow is not blocked for an unconfigured failed outcome',
    };

  const stage = definition.stages[stageName(state.currentStage)]!;
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(
      state,
      input,
      OrchestrationEventType.OperatorRetryRequested,
      { activationId: state.pendingActivation!.activationId, commandId: input.commandId },
      1,
    ),
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
        stage: stageName(state.currentStage),
      }),
      2,
    ),
  ];
  return { kind: 'append', events };
}
