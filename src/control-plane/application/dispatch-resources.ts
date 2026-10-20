import type { RepositoryAssignment } from '../../execution/index.js';
import { resourceId, type ResourceService } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { OrchestrationPort } from './activation-scheduler-ports.js';

export async function dispatchResources(
  resources: ResourceService,
  workItemId: WorkItemId,
  assignment: RepositoryAssignment | undefined,
) {
  const correlated = await resources.correlationsForWork(workItemId);
  const views = (
    await Promise.all(correlated.map((entry) => resources.get(entry.resourceId)))
  ).filter((entry) => entry !== null);
  if (
    assignment !== undefined &&
    !views.some((entry) => entry.resourceId === assignment.resourceId)
  ) {
    const repository = await resources.get(resourceId(assignment.resourceId));
    if (repository === null)
      throw new Error(`Assigned repository ${assignment.resourceId} is unavailable`);
    views.push(repository);
  }
  return views;
}

export async function dispatchRepositoryContext(
  orchestration: OrchestrationPort,
  resources: ResourceService,
  workItemId: WorkItemId,
) {
  const repositoryAssignment = await orchestration.repositoryAssignment?.(workItemId);
  const changeOutputAssignments = await orchestration.changeOutputAssignments?.(workItemId);
  return {
    resources: await dispatchResources(resources, workItemId, repositoryAssignment),
    ...(repositoryAssignment === undefined ? {} : { repositoryAssignment }),
    ...(changeOutputAssignments === undefined ? {} : { changeOutputAssignments }),
  };
}
