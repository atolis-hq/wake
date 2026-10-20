import { ActivityExecutionKind, type ActivityRegistry } from '../../activities/index.js';
import { WorkspaceMode } from '../../execution/index.js';
import type { CompiledStage, WorkflowDefinitionConfig } from '../contracts/config.js';
import { stageName, type StageName } from '../contracts/identifiers.js';
import { DeliveryCompletion } from '../contracts/vocabulary.js';

type Stages = Readonly<Record<StageName, CompiledStage>>;

export function assertDeliveryQa(
  config: WorkflowDefinitionConfig,
  stages: Stages,
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
  assertDeliveryMaintenance(config, stages, activities);
}

/** Maintenance writes through branch leases Wake prepares, so its stage brings no workspace. */
function assertDeliveryMaintenance(
  config: WorkflowDefinitionConfig,
  stages: Stages,
  activities: ActivityRegistry,
): void {
  const maintenance = config.delegation?.maintenance;
  if (maintenance === undefined) return;
  const stage = stages[stageName(maintenance.stage)];
  if (
    config.delegation?.completion !== DeliveryCompletion.MergeRequired ||
    !isLeaseOnlyAgentStage(stage, activities)
  )
    throw new Error(
      'Delegation maintenance must name an agent stage without a workspace of its own in a merge-required delivery; Wake leases the target branches',
    );
  if (maintenance.stage === config.delegation?.qa?.stage)
    throw new Error('Delegation maintenance cannot reuse the QA stage');
}

function isLeaseOnlyAgentStage(stage: CompiledStage | undefined, activities: ActivityRegistry) {
  return (
    stage !== undefined &&
    (stage.execution?.workspace ?? WorkspaceMode.None) === WorkspaceMode.None &&
    activities.describe(stage.activity).executionKind === ActivityExecutionKind.Agent
  );
}
