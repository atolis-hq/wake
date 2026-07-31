import type { WorkItemView } from '../../../work/index.js';
import { toWorkItemKey, type WorkItemResponse } from '../contracts/work.js';

/** The current Wake work identity is the canonical transport key; retain the mapping centrally. */
export function presentWorkItem(work: WorkItemView): WorkItemResponse {
  return {
    workItemKey: toWorkItemKey(work.workItemId),
    workItemId: work.workItemId,
    objective: work.objective,
    state: work.state,
    relatedWorkItems: work.relatedWorkItems.map((item) => ({
      workItemKey: toWorkItemKey(item.workItemId),
      relation: item.relation,
    })),
  };
}
