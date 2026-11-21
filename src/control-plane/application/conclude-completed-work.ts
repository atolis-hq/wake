import { WorkflowStatus } from '../../orchestration/index.js';
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
  if (
    conclusion === undefined ||
    work === undefined ||
    orchestration.listAll === undefined ||
    orchestration.getPrimaryWorkflowInstanceId === undefined
  )
    return;
  for (const workflow of await orchestration.listAll()) {
    if (workflow.status !== WorkflowStatus.Completed || workflow.concludesWork !== true) continue;
    // Cheapest filter first so long-closed items add no per-pass lookups.
    const item = await work.get(workflow.workItemId);
    if (item?.state !== WorkStatus.Open || item.deleted === true) continue;
    const primary = await orchestration.getPrimaryWorkflowInstanceId(workflow.workItemId);
    if (primary !== workflow.workflowInstanceId) continue;
    await conclusion.closeWork(workflow.workItemId, 'workflow completed');
  }
}
