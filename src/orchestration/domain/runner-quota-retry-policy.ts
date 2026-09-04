import { activationId as toActivationId } from '../../activities/index.js';
import {
  OrchestrationEventType,
  type WorkflowOrchestrationEventData,
} from '../contracts/events.js';
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
  state: WorkflowInstanceView,
  input: RunnerQuotaRetryRequest,
): OrchestrationDecision {
  if (!isRunnerQuotaRetryEligible(state, input.activationId))
    return {
      kind: 'ignored',
      reason: 'workflow has no matching pending activation for runner-quota retry',
    };
  // Re-request the interrupted Activation itself, not the current stage's
  // configured activity: a supplemental or follow-on Activation runs a
  // different activity and input, and substituting the stage's main one would
  // drop that work and re-run something the runner never attempted.
  const interrupted = state.pendingActivation!;
  // No RetryCounted here, deliberately: a quota condition is a runner-capacity
  // fact, not a failed attempt, so it must never consume the route's
  // configured `retry.max` budget.
  const events: WorkflowOrchestrationEventData[] = [
    stateDraft(
      state,
      input,
      {
        eventType: OrchestrationEventType.ActivityRetriedForRunnerQuota,
        payload: {
          activationId: toActivationId(input.activationId),
          runId: input.runId,
          runnerName: input.runnerName,
          message: input.message,
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
          interrupted.activity,
          interrupted.input,
          {
            execution: interrupted.execution,
            ...(interrupted.stage === undefined ? {} : { stage: interrupted.stage }),
            ...(interrupted.followOnIndex === undefined
              ? {}
              : { followOnIndex: interrupted.followOnIndex }),
            ...(interrupted.supplemental === undefined
              ? {}
              : { supplemental: interrupted.supplemental }),
          },
        ),
      },
      2,
    ),
  ];
  return { kind: 'append', events };
}
