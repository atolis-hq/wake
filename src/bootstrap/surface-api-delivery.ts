import { presentResource, toWorkItemKey, type WorkDetailResponse } from '../surfaces/index.js';
import type { WorkItemView } from '../work/index.js';
import type { CompositionRoot } from './composition-root.js';

export async function presentDelivery(
  root: CompositionRoot,
  work: WorkItemView,
): Promise<Pick<WorkDetailResponse, 'delegation'>> {
  if ((root as Partial<CompositionRoot>).orchestration?.deliveryTree === undefined) return {};
  const cohorts = await root.orchestration.deliveryTree(work.workItemId);
  if (cohorts.length === 0 && work.delegation === undefined) return {};
  const delivery = await root.work.deliverySnapshot();
  return {
    delegation: {
      rootWorkItemKey: toWorkItemKey(work.delegation?.rootWorkItemId ?? work.workItemId),
      ...(work.delegation === undefined
        ? {}
        : { parentWorkItemKey: toWorkItemKey(work.delegation.parentWorkItemId) }),
      children: await Promise.all(
        cohorts.flatMap((cohort) =>
          cohort.children.map(async (child) => {
            const availability = delivery.availability(child.workItemId);
            const resources = await Promise.all(
              (await root.resources.correlationsForWork(child.workItemId)).map((entry) =>
                root.resources.get(entry.resourceId),
              ),
            );
            return {
              workItemKey: toWorkItemKey(child.workItemId),
              parentWorkItemKey: toWorkItemKey(cohort.parentWorkItemId),
              objective: child.objective,
              workflowName: child.workflowName,
              status: child.workflow?.status ?? 'registration-pending',
              cohortId: cohort.cohortId,
              ...((availability.reason ?? child.workflow?.blockReason)
                ? { blockReason: (availability.reason ?? child.workflow?.blockReason)! }
                : {}),
              resources: resources
                .filter((entry) => entry !== null)
                .map(presentResource(root.resolveResourceLink)),
            };
          }),
        ),
      ),
    },
  };
}
