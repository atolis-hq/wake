import { ActivityOutcomeKind, BuiltInActivityName } from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowOrchestrationEventDraft } from '../contracts/events.js';
import { OrchestrationEventType, WatchGateVerdictSignal } from '../contracts/events.js';
import { signalName, stageName, watchId } from '../contracts/identifiers.js';
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

// `then: await-human` on a `failed` route compiles its wait to this literal
// signal name (see compileTarget); a workflow parked there has exhausted
// whatever automatic retries it had and is durably equivalent to a blocked
// failed stage for operator-retry purposes.
const FailedOutcomeSignal = signalName(ActivityOutcomeKind.Failed);

export function isOperatorRetryEligible(view: WorkflowInstanceView): boolean {
  const pending = view.pendingActivation;
  const eligibleActivation =
    pending !== undefined &&
    pending.status === ActivityActivationStatus.Completed &&
    pending.supplemental !== true &&
    pending.followOnIndex === undefined &&
    view.acceptedOutcomes.includes(pending.activationId);
  if (!eligibleActivation || pending === undefined) return false;
  if (view.status === WorkflowStatus.Blocked) return isRetryEligibleBlock(view, pending);
  return isRetryEligibleFailedWait(view);
}

function isRetryEligibleBlock(
  view: WorkflowInstanceView,
  pending: NonNullable<WorkflowInstanceView['pendingActivation']>,
): boolean {
  return (
    (view.blockReason === 'unconfigured outcome failed' &&
      view.lastOutcome?.kind === ActivityOutcomeKind.Failed) ||
    view.executionFailure?.activationId === pending.activationId
  );
}

function isRetryEligibleFailedWait(view: WorkflowInstanceView): boolean {
  return (
    view.status === WorkflowStatus.Waiting &&
    view.waitingFor?.signalKind === FailedOutcomeSignal &&
    view.lastOutcome?.kind === ActivityOutcomeKind.Failed
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
  const completedAgentStage =
    pending !== undefined &&
    pending.activity === BuiltInActivityName.Agent &&
    pending.status === ActivityActivationStatus.Completed &&
    pending.supplemental !== true &&
    pending.followOnIndex === undefined &&
    view.acceptedOutcomes.includes(pending.activationId);
  if (!completedAgentStage) return false;
  return (
    (view.status === WorkflowStatus.Blocked &&
      view.blockReason === 'unconfigured outcome blocked' &&
      view.lastOutcome?.kind === ActivityOutcomeKind.Blocked) ||
    (view.status === WorkflowStatus.Waiting && view.waitingFor !== undefined)
  );
}

export function isGroupBudgetExtensionEligible(view: WorkflowInstanceView): boolean {
  return (
    view.status === WorkflowStatus.Blocked &&
    view.blockReason?.startsWith('watch group budget exhausted for ') === true &&
    view.waitingFor !== undefined
  );
}

export function requestOperatorRetry(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: OperatorRetryRequest,
): OrchestrationDecision {
  return requestRetry(definition, state, input);
}

/** Re-requests the failed stage while requiring a new runner session. */
export function requestFreshOperatorRetry(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: OperatorRetryRequest,
): OrchestrationDecision {
  return requestRetry(definition, state, input, 'fresh');
}

function requestRetry(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: OperatorRetryRequest,
  sessionPolicy?: 'fresh',
): OrchestrationDecision {
  if (input.commandId.length === 0)
    return { kind: 'ignored', reason: 'operator retry command id is required' };
  if (!isOperatorRetryEligible(state))
    return {
      kind: 'ignored',
      reason: 'workflow is not in a retryable failed-stage state',
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
        ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
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
