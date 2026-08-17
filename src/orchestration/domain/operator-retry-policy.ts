import { ActivityOutcomeKind, BuiltInActivityName } from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import { OrchestrationEventType, WatchGateVerdictSignal } from '../contracts/events.js';
import { stageName, watchId } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import {
  ActivityActivationStatus,
  ApprovalAuthorityKind,
  WorkflowStatus,
} from '../contracts/vocabulary.js';
import type { DecisionContext, OrchestrationDecision } from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

export interface OperatorRetryRequest extends DecisionContext {
  readonly commandId: string;
}

export function isOperatorRetryEligible(view: WorkflowInstanceView): boolean {
  const pending = view.pendingActivation;
  const eligibleActivation =
    view.status === WorkflowStatus.Blocked &&
    pending !== undefined &&
    pending.status === ActivityActivationStatus.Completed &&
    pending.supplemental !== true &&
    pending.followOnIndex === undefined &&
    view.acceptedOutcomes.includes(pending.activationId);
  if (!eligibleActivation || pending === undefined) return false;
  return (
    (view.blockReason === 'unconfigured outcome failed' &&
      view.lastOutcome?.kind === ActivityOutcomeKind.Failed) ||
    view.executionFailure?.activationId === pending.activationId
  );
}

export function selectOperatorRetryTarget(
  workflows: readonly WorkflowInstanceView[],
): WorkflowInstanceView | undefined {
  const primary = workflows.find((workflow) => workflow.parentWorkflowInstanceId === undefined);
  if (primary === undefined) return undefined;
  if (isOperatorRetryEligible(primary)) return primary;
  if (
    primary.status !== WorkflowStatus.Waiting ||
    primary.waitingFor?.signalKind !== WatchGateVerdictSignal
  )
    return undefined;
  const watched = new Set(
    (primary.waitingFor.from ?? []).flatMap((authority) =>
      authority.kind === ApprovalAuthorityKind.Watch ? [authority.watch] : [],
    ),
  );
  return workflows.find(
    (workflow) =>
      workflow.parentWorkflowInstanceId === primary.workflowInstanceId &&
      workflow.workItemId === primary.workItemId &&
      workflow.orchestrationGroupId === primary.orchestrationGroupId &&
      workflow.watchId !== undefined &&
      watched.has(watchId(workflow.watchId)) &&
      isOperatorRetryEligible(workflow),
  );
}

export function isChangesResumeEligible(view: WorkflowInstanceView): boolean {
  const pending = view.pendingActivation;
  return (
    view.status === WorkflowStatus.Blocked &&
    view.blockReason === 'unconfigured outcome blocked' &&
    pending !== undefined &&
    pending.activity === BuiltInActivityName.Agent &&
    pending.status === ActivityActivationStatus.Completed &&
    pending.supplemental !== true &&
    pending.followOnIndex === undefined &&
    view.lastOutcome?.kind === ActivityOutcomeKind.Blocked &&
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
      reason: 'workflow is not blocked for a retryable failed stage',
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

export function requestChangesResume(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: OperatorRetryRequest,
): OrchestrationDecision {
  if (input.commandId.length === 0)
    return { kind: 'ignored', reason: 'changes resume command id is required' };
  if (!isChangesResumeEligible(state))
    return {
      kind: 'ignored',
      reason: 'workflow is not blocked for an unconfigured agent blocked outcome',
    };

  const stage = definition.stages[stageName(state.currentStage)]!;
  return {
    kind: 'append',
    events: [
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
    ],
  };
}
