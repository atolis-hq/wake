import { ActivityOutcomeKind, type ActivityRegistry } from '../../activities/index.js';
import type { CompiledStage } from '../contracts/config.js';
import type { StageName } from '../contracts/identifiers.js';

export interface WorkflowCompileDiagnostic {
  readonly workflow: string;
  readonly stage: string;
  readonly outcome: string;
  readonly message: string;
}

const hasDeliveryScope = (stage: CompiledStage) =>
  typeof stage.with === 'object' && stage.with !== null && 'scope' in stage.with;

export function reportUnroutedOutcomes(
  workflow: string,
  stages: Readonly<Record<StageName, CompiledStage>>,
  activities: ActivityRegistry,
  report: (diagnostic: WorkflowCompileDiagnostic) => void,
): void {
  for (const [stage, configured] of Object.entries(stages)) {
    for (const outcome of activities.describe(configured.activity).outcomeKinds) {
      if (Object.hasOwn(configured.on, outcome)) continue;
      // Only a parent delivery scope can finish with nothing left to integrate.
      if (outcome === ActivityOutcomeKind.Integrated && !hasDeliveryScope(configured)) continue;
      report({
        workflow,
        stage,
        outcome,
        message: `Workflow "${workflow}" stage "${stage}": declared outcome "${outcome}" has no route.`,
      });
    }
  }
}
