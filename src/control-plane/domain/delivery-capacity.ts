import type { RunView } from '../../execution/index.js';
import { isActiveRunStatus } from '../../execution/index.js';
import { WorkflowStatus, type WorkflowInstanceView } from '../../orchestration/index.js';
import type { DeliverySnapshot, WorkItemId } from '../../work/index.js';

/** A waiting workflow is not a Run; every actual Run, including watches, counts. */
export async function deliveryCapacity(
  workflows: readonly WorkflowInstanceView[],
  runs: readonly RunView[],
  work: DeliverySnapshot | undefined,
  runLimit: ((id: WorkItemId) => Promise<number | undefined>) | undefined,
): Promise<{
  roots: ReadonlyMap<string, string>;
  unavailable: ReadonlySet<string>;
  full: ReadonlySet<string>;
}> {
  const activeWorkflowIds = new Set(
    runs.filter((run) => isActiveRunStatus(run.status)).map((run) => run.workflowInstanceId),
  );
  // Concluded history cannot dispatch or hold a Run, so it needs no ancestry reads.
  const live = workflows.filter(
    (workflow) =>
      activeWorkflowIds.has(workflow.workflowInstanceId) ||
      (workflow.status !== WorkflowStatus.Completed &&
        workflow.status !== WorkflowStatus.Superseded),
  );
  const roots = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const id of new Set(live.map((workflow) => workflow.workItemId))) {
    const delivery = work === undefined ? { rootWorkItemId: id } : work.availability(id);
    roots.set(id, delivery.rootWorkItemId);
    if (delivery.reason !== undefined) unavailable.add(id);
  }
  const full = new Set<string>();
  // A root without an active Run cannot be at a positive limit.
  await Promise.all(
    [...activeRunCounts(live, runs, roots)].map(async ([root, count]) => {
      const limit = await runLimit?.(root as WorkItemId);
      if (limit !== undefined && count >= limit) full.add(root);
    }),
  );
  return { roots, unavailable, full };
}

function activeRunCounts(
  workflows: readonly WorkflowInstanceView[],
  runs: readonly RunView[],
  roots: ReadonlyMap<string, string>,
) {
  const byId = new Map(workflows.map((workflow) => [workflow.workflowInstanceId, workflow]));
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (!isActiveRunStatus(run.status)) continue;
    const workflow = byId.get(run.workflowInstanceId);
    if (workflow === undefined) continue;
    const root = roots.get(workflow.workItemId)!;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}
