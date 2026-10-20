import {
  ActivityOutcomeKind,
  BuiltInActivityName,
  isNeedsClarificationAgentOutcome,
} from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowOrchestrationEventData } from '../contracts/events.js';
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
import { AwaitTimeoutBlockReason } from './signal-policy.js';

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
  const deliveryGate =
    view.status === WorkflowStatus.Blocked && view.deliveryGateBlock !== undefined;
  const eligibleActivation =
    pending !== undefined &&
    retryableActivationStatus(pending.status, deliveryGate) &&
    pending.supplemental !== true &&
    (pending.followOnIndex === undefined || deliveryGate) &&
    (deliveryGate || view.acceptedOutcomes.includes(pending.activationId));
  if (!eligibleActivation || pending === undefined) return false;
  if (view.status === WorkflowStatus.Blocked) return isRetryEligibleBlock(view, pending);
  return isRetryEligibleFailedWait(view);
}

function retryableActivationStatus(
  status: ActivityActivationStatus,
  deliveryGate: boolean,
): boolean {
  return (
    status === ActivityActivationStatus.Completed ||
    (deliveryGate && status === ActivityActivationStatus.Waiting)
  );
}

function isRetryEligibleBlock(
  view: WorkflowInstanceView,
  pending: NonNullable<WorkflowInstanceView['pendingActivation']>,
): boolean {
  return (
    view.deliveryGateBlock !== undefined ||
    view.blockReason === AwaitTimeoutBlockReason ||
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

export function selectChangesResumeTargets(
  workflows: readonly WorkflowInstanceView[],
): readonly WorkflowInstanceView[] {
  const primary = workflows.find((workflow) => workflow.parentWorkflowInstanceId === undefined);
  if (primary === undefined) return [];
  if (isChangesResumeEligible(primary)) return [primary];
  if (
    primary.status !== WorkflowStatus.Waiting ||
    primary.waitingFor?.signalKind !== WatchGateVerdictSignal
  )
    return [];
  const watches = new Set(
    (primary.waitingFor.from ?? []).flatMap((authority) =>
      authority.kind === ApprovalAuthorityKind.Watch ? [authority.watch] : [],
    ),
  );
  return workflows.filter(
    (workflow) =>
      workflow.parentWorkflowInstanceId === primary.workflowInstanceId &&
      workflow.workItemId === primary.workItemId &&
      workflow.orchestrationGroupId === primary.orchestrationGroupId &&
      workflow.watchId !== undefined &&
      watches.has(watchId(workflow.watchId)) &&
      isChangesResumeEligible(workflow),
  );
}

export function isChangesResumeEligible(view: WorkflowInstanceView): boolean {
  if (!isCompletedAgentStage(view)) return false;
  return (
    (view.status === WorkflowStatus.Blocked &&
      view.blockReason === 'unconfigured outcome blocked' &&
      view.lastOutcome?.kind === ActivityOutcomeKind.Blocked) ||
    (view.status === WorkflowStatus.Waiting &&
      view.waitingFor !== undefined &&
      view.lastOutcome?.kind !== ActivityOutcomeKind.Failed &&
      !(view.waitingFor.from ?? []).some(
        (authority) => authority.kind === ApprovalAuthorityKind.Watch,
      ))
  );
}

export function isPlainReplyResumeEligible(view: WorkflowInstanceView): boolean {
  return isChangesResumeEligible(view) && view.lastOutcome?.kind === ActivityOutcomeKind.Blocked;
}

/** A clarification reply may be supplied by any conversation participant. */
export function isNeedsClarificationResumeEligible(view: WorkflowInstanceView): boolean {
  return isChangesResumeEligible(view) && isNeedsClarificationAgentOutcome(view.lastOutcome);
}

function isCompletedAgentStage(view: WorkflowInstanceView): boolean {
  const pending = view.pendingActivation;
  return (
    pending !== undefined &&
    pending.activity === BuiltInActivityName.Agent &&
    pending.status === ActivityActivationStatus.Completed &&
    pending.supplemental !== true &&
    pending.followOnIndex === undefined &&
    view.acceptedOutcomes.includes(pending.activationId)
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

  const retryStage = state.deliveryGateBlock?.retryStage ?? state.currentStage;
  const stage = definition.stages[retryStage]!;
  if (state.deliveryGateBlock !== undefined) sessionPolicy = 'fresh';
  const events: WorkflowOrchestrationEventData[] = [
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.OperatorRetryRequested,
        payload: {
          activationId: state.pendingActivation!.activationId,
          commandId: input.commandId,
        },
      },
      1,
    ),
  ];
  if (retryStage !== state.currentStage)
    events.push(
      stateDraft(
        state,
        input,
        { eventType: OrchestrationEventType.StageEntered, payload: { stage: retryStage } },
        2,
      ),
    );
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
            stage: retryStage,
            ...(sessionPolicy === undefined ? {} : { sessionPolicy }),
          },
        ),
      },
      events.length + 1,
    ),
  );
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
        {
          eventType: OrchestrationEventType.OperatorRetryRequested,
          payload: {
            activationId: state.pendingActivation!.activationId,
            commandId: input.commandId,
          },
        },
        1,
      ),
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
        2,
      ),
    ],
  };
}
