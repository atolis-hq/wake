import type { RunnerSentinel, Stage, WorkflowDefinition } from '../domain/types.js';
import { builtInDefaultWorkflowDefinition, nextStage } from '../domain/workflows.js';

export function createLifecycleService() {
  return {
    nextStageFromSentinel(
      stage: Stage,
      sentinel: RunnerSentinel,
      workflow: WorkflowDefinition = builtInDefaultWorkflowDefinition,
    ): Stage | null {
      return nextStage(stage, sentinel, workflow);
    },
  };
}
