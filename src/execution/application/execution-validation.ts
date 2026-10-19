import { ActivityResourceCardinality, type ResourceRequirement } from '../../activities/index.js';
import { BuiltInResourceKind, type ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { RunId } from '../contracts/identifiers.js';
import type { RepositoryAssignment } from '../contracts/repository-assignment.js';
import { WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';

export async function acquireWorkspace(
  runId: RunId,
  mode: typeof WorkspaceMode.None | typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch,
  workItemId: WorkItemId,
  resources: readonly ResourceView[],
  provider?: WorkspaceProvider,
  options: {
    readonly signal?: AbortSignal | undefined;
    readonly assignment?: RepositoryAssignment | undefined;
    readonly reviewRevision?: string | undefined;
  } = {},
): Promise<WorkspaceLease | undefined> {
  const { signal = new AbortController().signal, assignment, reviewRevision } = options;
  if (mode === WorkspaceMode.None) return undefined;
  if (provider === undefined) throw new Error('Workspace provider is required');
  const repositoryResource = selectWorkspaceResource(resources, assignment);
  if (repositoryResource === undefined) throw new Error('Repository Resource is required');
  signal.throwIfAborted();
  const checkoutRevision = checkoutTarget(repositoryResource, mode, assignment, reviewRevision);
  return provider.acquire({
    runId,
    signal,
    mode,
    workItemId,
    repositoryResource,
    ...(assignment === undefined ? {} : { assignment }),
    ...(checkoutRevision === undefined ? {} : { checkoutRevision }),
  });
}

function checkoutTarget(
  resource: ResourceView,
  mode: string,
  assignment: RepositoryAssignment | undefined,
  reviewRevision: string | undefined,
) {
  if (assignment !== undefined)
    return mode === WorkspaceMode.ReadOnly
      ? (reviewRevision ?? assignment.sourceRevision)
      : assignment.sourceRevision;
  if (resource.kind === BuiltInResourceKind.Repository) return resource.revision;
  if (
    resource.kind === BuiltInResourceKind.PullRequest &&
    resource.revision !== undefined &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(resource.revision)
  )
    return resource.revision;
  return undefined;
}

export function validateResourceRequirements(
  requirements: readonly ResourceRequirement[],
  resources: readonly ResourceView[],
): void {
  for (const requirement of requirements) {
    const count = resources.filter((resource) =>
      resource.capabilities.includes(requirement.capability),
    ).length;
    if (requirement.cardinality === ActivityResourceCardinality.ExactlyOne && count !== 1)
      throw new Error(`Activity requires exactly one ${requirement.capability} Resource`);
    if (requirement.cardinality === ActivityResourceCardinality.OneOrMore && count < 1)
      throw new Error(`Activity requires ${requirement.capability} Resources`);
    if (requirement.cardinality === ActivityResourceCardinality.ZeroOrOne && count > 1)
      throw new Error(`Activity allows at most one ${requirement.capability} Resource`);
  }
}

function selectWorkspaceResource(
  resources: readonly ResourceView[],
  assignment: RepositoryAssignment | undefined,
) {
  const repositoryResource =
    assignment === undefined
      ? (resources.find((resource) => resource.kind === BuiltInResourceKind.Repository) ??
        resources.find((resource) => resource.kind === BuiltInResourceKind.PullRequest) ??
        resources.find((resource) => resource.kind === BuiltInResourceKind.Issue))
      : resources.find(
          (resource) =>
            resource.resourceId === assignment.resourceId &&
            resource.kind === BuiltInResourceKind.Repository,
        );
  if (assignment !== undefined && repositoryResource === undefined)
    throw new Error('Assigned Repository Resource ' + assignment.resourceId + ' is unavailable');
  return repositoryResource;
}
