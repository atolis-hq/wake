import {
  TransitionTargetKind,
  WorkflowStatus,
  type CompiledWorkflow,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import { WorkStatus } from '../../work/index.js';
import type {
  ActivationSchedulerDependencies,
  OrchestrationPort,
} from './activation-scheduler-ports.js';

/**
 * Closes WorkItems whose primary workflow completed via a `concludesWork` route.
 * Re-checking the WorkItem state keeps this idempotent across passes and replay.
 */
export async function concludeCompletedWork(
  orchestration: OrchestrationPort,
  dependencies: ActivationSchedulerDependencies,
): Promise<void> {
  const { conclusion, work } = dependencies;
  if (conclusion === undefined || work === undefined || !hasWorkflowLookups(orchestration)) return;
  const definitions = definitionsByName(orchestration);
  for (const workflow of await orchestration.listAll()) {
    if (!concludes(workflow, definitions)) continue;
    // Cheapest filter first so long-closed items add no per-pass lookups.
    const item = await work.get(workflow.workItemId);
    if (item?.state !== WorkStatus.Open || item.deleted === true) continue;
    const primary = await orchestration.getPrimaryWorkflowInstanceId(workflow.workItemId);
    if (primary !== workflow.workflowInstanceId) continue;
    await conclusion.closeWork(workflow.workItemId, 'workflow completed');
  }
}

/**
 * Instances completed before `concludesWork` was recorded carry no flag, so
 * they never closed their work. Treat a clean completion as concluding when
 * every route that completes its final stage now declares it; an ambiguous
 * stage (some completing routes do not conclude) is left alone.
 */
function completedLegacyConclusion(
  workflow: WorkflowInstanceView,
  definitions: ReadonlyMap<string, CompiledWorkflow>,
): boolean {
  if (workflow.concludesWork !== undefined || workflow.blockReason !== undefined) return false;
  const stage = definitions.get(workflow.workflowName)?.stages[workflow.currentStage];
  const completing = Object.values(stage?.on ?? {}).filter(
    (route) => route.target.kind === TransitionTargetKind.Complete,
  );
  return (
    completing.length > 0 &&
    completing.every(
      (route) =>
        route.target.kind === TransitionTargetKind.Complete && route.target.concludesWork === true,
    )
  );
}

function hasWorkflowLookups(
  orchestration: OrchestrationPort,
): orchestration is OrchestrationPort &
  Required<Pick<OrchestrationPort, 'listAll' | 'getPrimaryWorkflowInstanceId'>> {
  return (
    orchestration.listAll !== undefined && orchestration.getPrimaryWorkflowInstanceId !== undefined
  );
}

function definitionsByName(
  orchestration: OrchestrationPort,
): ReadonlyMap<string, CompiledWorkflow> {
  return new Map(
    (orchestration.listCurrentDefinitions?.() ?? []).map(({ definition }) => [
      definition.name as string,
      definition,
    ]),
  );
}

function concludes(
  workflow: WorkflowInstanceView,
  definitions: ReadonlyMap<string, CompiledWorkflow>,
): boolean {
  if (workflow.status !== WorkflowStatus.Completed) return false;
  return workflow.concludesWork === true || completedLegacyConclusion(workflow, definitions);
}
