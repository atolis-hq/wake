import { RetrySafety, type ActivityOutcome } from '../../activities/index.js';
import type { CompiledOutcomeRoute, CompiledWorkflow } from '../contracts/config.js';
import type { WorkflowOrchestrationEventData } from '../contracts/events.js';
import { OrchestrationEventType } from '../contracts/events.js';
import { stageName } from '../contracts/identifiers.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { AcceptActivityOutcome } from './activation-policy.js';
import { activation, nextOrdinal, stateDraft } from './decision-events.js';

export function mayRetry(
  route: CompiledOutcomeRoute,
  state: WorkflowInstanceView,
  outcome: ActivityOutcome,
): boolean {
  if (route.retry === undefined || requiresReconciliation(outcome)) return false;
  const retryKey = `${state.currentStage}:${outcome.kind}`;
  return (state.retryCounts[retryKey] ?? 0) < route.retry.max;
}

export function requestRetry(
  events: WorkflowOrchestrationEventData[],
  definition: CompiledWorkflow,
  state: WorkflowInstanceView,
  input: AcceptActivityOutcome,
): void {
  const retryKey = `${state.currentStage}:${input.outcome.kind}`;
  const count = (state.retryCounts[retryKey] ?? 0) + 1;
  const stage = definition.stages[stageName(state.currentStage)]!;
  events.push(
    stateDraft(
      state,
      input,
      OrchestrationEventType.RetryCounted,
      { retryKey, count },
      events.length + 1,
    ),
    stateDraft(
      state,
      input,
      OrchestrationEventType.ActivityRequested,
      activation(state.workflowInstanceId, nextOrdinal(state), stage.activity, stage.with, {
        execution: stage.execution,
        stage: stageName(state.currentStage),
      }),
      events.length + 2,
    ),
  );
}

function requiresReconciliation(outcome: ActivityOutcome): boolean {
  if (typeof outcome.data !== 'object' || outcome.data === null) return false;
  if (!('retrySafety' in outcome.data)) return false;
  return outcome.data.retrySafety === RetrySafety.RequiresReconciliation;
}
