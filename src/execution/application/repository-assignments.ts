import { BuiltInResourceKind, resourceId, type ResourceService } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type {
  RepositoryAssignment,
  RepositoryAssignmentRequest,
} from '../contracts/repository-assignment.js';

/** Correlations are the parent's explicit repository authority, not the provider catalogue. */
export function createRepositoryAssignments(
  resources: ResourceService,
  resolveSource: (request: RepositoryAssignmentRequest) => Promise<RepositoryAssignment>,
  inherited: (workItemId: string) => Promise<{ readonly resourceId: string } | undefined>,
  permitted?: (workItemId: string) => Promise<readonly string[] | undefined>,
) {
  return {
    async resolve(
      parent: { readonly workItemId: WorkItemId },
      request: RepositoryAssignmentRequest,
    ) {
      const repository = await resources.get(resourceId(request.resourceId));
      if (repository === null || repository.kind !== BuiltInResourceKind.Repository)
        throw new Error(
          `Repository Resource ${request.resourceId} is unavailable; select an existing Repository Resource`,
        );
      const correlations = await resources.correlationsForWork(parent.workItemId);
      const scope = await inherited(parent.workItemId);
      const authority = await permitted?.(parent.workItemId);
      if (
        authority !== undefined
          ? !authority.includes(repository.resourceId)
          : scope === undefined
            ? !correlations.some((entry) => entry.resourceId === repository.resourceId)
            : scope.resourceId !== repository.resourceId
      )
        throw new Error(
          `Repository ${request.resourceId} is outside the parent assignment; explicitly authorize the repository before delegating`,
        );
      return resolveSource(request);
    },
  };
}
