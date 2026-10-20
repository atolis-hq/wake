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
  const qa = await deliveryQaFor(root, work);
  return {
    delegation: {
      ...(qa === undefined ? {} : { qa }),
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
              ...((availability.reason ?? child.prerequisiteBlocker ?? child.workflow?.blockReason)
                ? {
                    blockReason: (availability.reason ??
                      child.prerequisiteBlocker ??
                      child.workflow?.blockReason)!,
                  }
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

async function deliveryQaFor(root: CompositionRoot, work: WorkItemView) {
  const parent = (await root.orchestration.listAll()).find(
    (view) => view.workItemId === work.workItemId && view.parentWorkflowInstanceId === undefined,
  );
  const state =
    parent === undefined
      ? undefined
      : await root.orchestration.deliveryStateFor(parent.workflowInstanceId);
  return state === undefined
    ? undefined
    : {
        selectionRevision: state.selectionRevision,
        ...(state.candidate === null ? {} : { candidateId: state.candidate.candidateId }),
        repositories:
          state.candidate?.repositories.map((entry) => ({
            resourceId: entry.resourceId,
            revision: entry.revision,
          })) ?? [],
        stale: state.stale,
        ...(state.qa === null ? {} : { verdict: state.qa.verdict }),
        effective: state.qaEffective,
        canComplete: state.completion.complete,
        ...(state.completion.reason === undefined ? {} : { reason: state.completion.reason }),
        exhausted: state.repair.exhausted,
        findings: state.repair.unresolvedFindings,
      };
}
