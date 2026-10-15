import type { ActivityRegistry } from '../../activities/index.js';
import type { CompiledStage } from '../contracts/config.js';
import type { StageName } from '../contracts/identifiers.js';

export interface WorkflowCompileDiagnostic {
  readonly workflow: string;
  readonly stage: string;
  readonly outcome: string;
  readonly message: string;
}

export function reportUnroutedOutcomes(
  workflow: string,
  stages: Readonly<Record<StageName, CompiledStage>>,
  activities: ActivityRegistry,
  report: (diagnostic: WorkflowCompileDiagnostic) => void,
): void {
  for (const [stage, configured] of Object.entries(stages)) {
    for (const outcome of activities.describe(configured.activity).outcomeKinds) {
      if (Object.hasOwn(configured.on, outcome)) continue;
      report({
        workflow,
        stage,
        outcome,
        message: `Workflow "${workflow}" stage "${stage}": declared outcome "${outcome}" has no route.`,
      });
    }
  }
}
