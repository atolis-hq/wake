import {
  ActivityActivationStatus,
  WorkflowStatus,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';

export interface WorkAvailability {
  readonly frozen?: boolean;
  readonly deleted?: boolean;
}

/** Distinct started items with any nonterminal workflow, including waiting children. */
export function deriveOpenWorkItemIds(
  workflows: readonly WorkflowInstanceView[],
  unavailable: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const started = new Set<string>();
  const unfinished = new Set<string>();
  for (const workflow of workflows) {
    if (unavailable.has(workflow.workItemId)) continue;
    if (
      workflow.hasStartedActivation === true ||
      workflow.acceptedOutcomes.length > 0 ||
      (workflow.pendingActivation !== undefined &&
        workflow.pendingActivation.status !== ActivityActivationStatus.Pending)
    )
      started.add(workflow.workItemId);
    if (
      workflow.status !== WorkflowStatus.Completed &&
      workflow.status !== WorkflowStatus.Superseded
    )
      unfinished.add(workflow.workItemId);
  }
  return new Set([...started].filter((id) => unfinished.has(id)));
}

export function hasOpenWorkCapacity(open: ReadonlySet<string>, limit: number | null): boolean {
  return limit === null || open.size < limit;
}

export function canDispatchWorkItem(
  workItemId: string,
  open: ReadonlySet<string>,
  limit: number | null,
): boolean {
  return open.has(workItemId) || hasOpenWorkCapacity(open, limit);
}

export async function readOpenWorkItemIds(
  workflows: readonly WorkflowInstanceView[],
  work?: { get(id: string): Promise<WorkAvailability | null> },
): Promise<ReadonlySet<string>> {
  const unavailable = new Set<string>();
  await Promise.all(
    [...new Set(workflows.map((view) => view.workItemId))].map(async (id) => {
      const item = await work?.get(id);
      if (item?.frozen === true || item?.deleted === true) unavailable.add(id);
    }),
  );
  return deriveOpenWorkItemIds(workflows, unavailable);
}
