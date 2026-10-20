import type { ChangeOutputWorkspace } from '../../execution/index.js';
import { resourceId, type ResourceService } from '../../resources/index.js';

export interface ArtifactSourceRun {
  readonly repositoryAssignment?:
    { readonly resourceId: string; readonly pullRequestBase: string } | undefined;
  readonly workspaceRevision?: string | undefined;
  readonly changeOutputs?: readonly ChangeOutputWorkspace[] | undefined;
  readonly workspace?: {
    readonly branch?: string | undefined;
    readonly changeOutputs?: readonly ChangeOutputWorkspace[] | undefined;
  };
}

/** Resolve a claim name only against Execution's durable snapshot, including ambiguity retries. */
export async function artifactVerificationSource(
  run: ArtifactSourceRun | undefined,
  branch: string,
  name: string | undefined,
  resources: ResourceService,
) {
  const source = namedSource(run, branch, name);
  if (source === null) return null;
  const assignment = source.repositoryAssignment;
  // Direct workflows retain branch-only verification.
  if (assignment === undefined) return { workspaceBranch: source.branch };
  const repository = await resources.get(resourceId(assignment.resourceId));
  if (repository === null || source.workspaceRevision === undefined) return null;
  return {
    workspaceBranch: source.branch,
    repository: repository.externalKey,
    workspaceRevision: source.workspaceRevision,
    pullRequestBase: assignment.pullRequestBase,
  };
}

function namedSource(run: ArtifactSourceRun | undefined, branch: string, name: string | undefined) {
  if (run?.workspace?.changeOutputs === undefined)
    return {
      branch,
      repositoryAssignment: run?.repositoryAssignment,
      workspaceRevision: run?.workspaceRevision,
    };
  const output = run.changeOutputs?.find((entry) => entry.name === name);
  return output === undefined
    ? null
    : {
        branch: output.branch,
        repositoryAssignment: output.repository,
        workspaceRevision: output.revision,
      };
}
