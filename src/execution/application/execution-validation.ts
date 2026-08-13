import { ActivityResourceCardinality, type ResourceRequirement } from '../../activities/index.js';
import { BuiltInResourceKind, type ResourceView } from '../../resources/index.js';
import type { WorkItemId } from '../../work/index.js';
import type { RunId } from '../contracts/identifiers.js';
import { WorkspaceMode } from '../contracts/vocabulary.js';
import type { WorkspaceLease, WorkspaceProvider } from '../contracts/workspace.js';

export async function acquireWorkspace(
  runId: RunId,
  mode: typeof WorkspaceMode.None | typeof WorkspaceMode.ReadOnly | typeof WorkspaceMode.Branch,
  workItemId: WorkItemId,
  resources: readonly ResourceView[],
  provider?: WorkspaceProvider,
): Promise<WorkspaceLease | undefined> {
  if (mode === WorkspaceMode.None) return undefined;
  if (provider === undefined) throw new Error('Workspace provider is required');
  const repositoryResource =
    resources.find((resource) => resource.kind === BuiltInResourceKind.Repository) ??
    resources.find(
      (resource) =>
        resource.kind === BuiltInResourceKind.Issue ||
        resource.kind === BuiltInResourceKind.PullRequest,
    );
  if (repositoryResource === undefined) throw new Error('Repository Resource is required');
  return provider.acquire({ runId, mode, workItemId, repositoryResource });
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
