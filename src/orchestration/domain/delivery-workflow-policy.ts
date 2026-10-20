import { ActivityExecutionKind, type ActivityRegistry } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import type { CompiledStage, WorkflowDefinitionConfig } from '../contracts/config.js';
import { stageName, type StageName } from '../contracts/identifiers.js';

export function assertDeliveryQa(
  config: WorkflowDefinitionConfig,
  stages: Readonly<Record<StageName, CompiledStage>>,
  activities: ActivityRegistry,
): void {
  const qa = config.delegation?.qa;
  if (qa !== undefined) {
    const stage = stages[stageName(qa.stage)];
    if (
      stage === undefined ||
      stage.execution?.workspace !== WorkspaceMode.ReadOnly ||
      activities.describe(stage.activity).executionKind !== ActivityExecutionKind.Agent
    )
      throw new Error('Delegation QA must name a configured read-only agent stage');
  }
}
