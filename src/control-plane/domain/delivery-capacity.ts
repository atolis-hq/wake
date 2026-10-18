import type { RunView } from '../../execution/index.js';
import { isActiveRunStatus } from '../../execution/index.js';
import type { WorkflowInstanceView } from '../../orchestration/index.js';
import { readDeliveryAvailability, type WorkItemId } from '../../work/index.js';
import type { WorkAvailability } from './open-work-policy.js';

/** A waiting workflow is not a Run; every actual Run, including watches, counts. */
export async function deliveryCapacity(
  workflows: readonly WorkflowInstanceView[],
  runs: readonly RunView[],
  work: { get(id: string): Promise<WorkAvailability | null> } | undefined,
  runLimit: ((id: WorkItemId) => Promise<number | undefined>) | undefined,
): Promise<{
  roots: ReadonlyMap<string, string>;
  unavailable: ReadonlySet<string>;
  full: ReadonlySet<string>;
}> {
  const roots = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const workflow of workflows) {
    if (roots.has(workflow.workItemId)) continue;
    const delivery =
      work === undefined
        ? { rootWorkItemId: workflow.workItemId }
        : await readDeliveryAvailability(workflow.workItemId, work);
    roots.set(workflow.workItemId, delivery.rootWorkItemId);
    if (delivery.reason !== undefined) unavailable.add(workflow.workItemId);
  }
  const counts = activeRunCounts(workflows, runs, roots);
  const full = new Set<string>();
  for (const root of new Set(roots.values())) {
    const limit = await runLimit?.(root as WorkItemId);
    if (limit !== undefined && (counts.get(root) ?? 0) >= limit) full.add(root);
  }
  return { roots, unavailable, full };
}

function activeRunCounts(
  workflows: readonly WorkflowInstanceView[],
  runs: readonly RunView[],
  roots: ReadonlyMap<string, string>,
) {
  const counts = new Map<string, number>();
  for (const run of runs.filter((entry) => isActiveRunStatus(entry.status))) {
    const workflow = workflows.find((entry) => entry.workflowInstanceId === run.workflowInstanceId);
    if (workflow === undefined) continue;
    const root = roots.get(workflow.workItemId)!;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}
