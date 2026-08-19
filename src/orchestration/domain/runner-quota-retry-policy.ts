import { activationId as toActivationId } from '../../activities/index.js';
import type { CompiledWorkflow } from '../contracts/config.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEventDraft,
} from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { DecisionContext, OrchestrationDecision } from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

export interface RunnerQuotaRetryRequest extends DecisionContext {
  readonly activationId: string;
  readonly runId: string;
  readonly runnerName: string;
  readonly message: string;
}

export function isRunnerQuotaRetryEligible(
  view: WorkflowInstanceView,
  activationId: string,
): boolean {
  return (
    view.pendingActivation?.activationId === activationId &&
    !view.acceptedOutcomes.includes(toActivationId(activationId))
  );
}

export function requestRunnerQuotaRetry(
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: RunnerQuotaRetryRequest,
): OrchestrationDecision {
  if (!isRunnerQuotaRetryEligible(state, input.activationId))
    return {
      kind: 'ignored',
      reason: 'workflow has no matching pending activation for runner-quota retry',
    };
  const stage = definition.stages[stageName(state.currentStage)]!;
  const events: WorkflowOrchestrationEventDraft[] = [
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRetriedForRunnerQuota,
      {
        activationId: toActivationId(input.activationId),
        runId: input.runId,
        runnerName: input.runnerName,
        message: input.message,
      },
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
