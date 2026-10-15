import type { CompiledStage, CompiledWorkflow } from '../contracts/config.js';
import type { ActivityActivationView, WorkflowInstanceView } from '../contracts/views.js';
import { remainingAgentSteps, UnreachableRemainingSteps } from './workflow-graph.js';

export interface PendingActivationPriority {
  /** Agent stages left on the cheapest path to completion, or UnreachableRemainingSteps. */
  readonly remainingAgentSteps: number;
  readonly watchDriven: boolean;
  readonly retried: boolean;
}

// Retry keys are `<stage>:<outcomeKind>`; a stage is retried once any key for it has counted.
function isStageRetried(view: WorkflowInstanceView, stage: string): boolean {
  return Object.entries(view.retryCounts).some(
    ([key, count]) => count > 0 && key.startsWith(`${stage}:`),
  );
}

export function pendingActivationPriority(
  definition: CompiledWorkflow | null,
  view: WorkflowInstanceView,
  activation: ActivityActivationView,
  isAgentActivity: (activity: CompiledStage['activity']) => boolean,
): PendingActivationPriority {
  const stage = activation.stage ?? view.currentStage;
  const costs: Readonly<Record<string, number>> | undefined =
    definition === null
      ? undefined
      : (definition.remainingAgentSteps ?? remainingAgentSteps(definition.stages, isAgentActivity));
  return {
    remainingAgentSteps: costs?.[stage] ?? UnreachableRemainingSteps,
    watchDriven: activation.watchDriven === true,
    retried: isStageRetried(view, stage),
  };
}
