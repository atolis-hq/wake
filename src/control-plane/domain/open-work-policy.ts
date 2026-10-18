import {
  ActivityActivationStatus,
  WorkflowStatus,
  type WorkflowInstanceView,
} from '../../orchestration/index.js';
import type { WorkDelegation } from '../../work/index.js';
import { readDeliveryAvailability } from '../../work/index.js';

export interface WorkAvailability {
  readonly state?: string;
  readonly delegation?: WorkDelegation;
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
  const roots = new Set<string>();
  for (const id of deriveOpenWorkItemIds(workflows)) {
    if (work === undefined) {
      roots.add(id);
      continue;
    }
    const delivery = await readDeliveryAvailability(id, work);
    if (delivery.reason === undefined) roots.add(delivery.rootWorkItemId);
  }
  return roots;
}
