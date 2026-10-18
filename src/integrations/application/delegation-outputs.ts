import { z } from 'zod';
import { reportedArtifactSchema, type PullRequestService } from '../../activities/index.js';
import { RunStatus, WorkspaceMode, type RunView } from '../../execution/index.js';
import type {
  DelegationArtifacts,
  DelegationOutputKind,
  WorkflowInstanceView,
} from '../../orchestration/index.js';
import {
  BuiltInResourceKind,
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  resourceId,
  type ResourceService,
} from '../../resources/index.js';
import { ArtifactVerificationResult } from '../contracts/artifact-vocabulary.js';
import type { ProviderInstance } from '../contracts/provider.js';

const reportsSchema = z.object({ reportedArtifacts: z.array(reportedArtifactSchema) });

type ChangeOutput = Extract<
  Parameters<DelegationArtifacts['qualifyingOutputs']>[1][number],
  { readonly kind: typeof DelegationOutputKind.Change }
>;

interface OutputDependencies {
  readonly artifacts: DelegationArtifacts;
  readonly resources: ResourceService;
  readonly pullRequests: PullRequestService;
  readonly runs: () => Promise<readonly RunView[]>;
  readonly providers: () => Promise<readonly ProviderInstance[]>;
}

/** Select exact provider-verified results owned by the producing child. */
export function createDelegationOutputs(input: OutputDependencies): DelegationArtifacts {
  return {
    ...input.artifacts,
    async qualifyingOutputs(child, outputs) {
      const artifacts = outputs.filter((output) => 'path' in output);
      const references =
        artifacts.length === 0 ? [] : await input.artifacts.qualifyingOutputs(child, artifacts);
      if (references === null) return null;
      for (const output of outputs) {
        if (!('kind' in output)) continue;
        const change = await qualifyingChange(input, child, output);
        if (change === null) return null;
        references.push(change);
      }
      return references;
    },
  };
}

function reportedChange(runs: readonly RunView[], name: string) {
  return runs
    .flatMap((run) => {
      const data = reportsSchema.safeParse(run.outcome?.data);
      return data.success
        ? data.data.reportedArtifacts
            .filter(
              (entry) => entry.name === name && entry.kind === BuiltInResourceKind.PullRequest,
            )
            .map((report) => ({ run, report }))
        : [];
    })
    .at(-1);
}

async function verifiedChange(
  input: OutputDependencies,
  report: NonNullable<ReturnType<typeof reportedChange>>['report'],
  source: NonNullable<ReturnType<typeof runSource>>,
) {
  const { assignment, branch, revision } = source;
  const repository = await input.resources.get(resourceId(assignment.resourceId));
  const provider = (await input.providers()).find(
    (entry) => entry.adapter === report.externalKey.adapter,
  );
  if (repository === null || provider === undefined) return null;
  const verified = await provider.verifyArtifact(
    BuiltInResourceKind.PullRequest,
    report.externalKey,
    {
      repository: repository.externalKey,
      workspaceBranch: branch,
      workspaceRevision: revision,
      pullRequestBase: assignment.pullRequestBase,
    },
  );
  if (verified === ArtifactVerificationResult.Ambiguous)
    throw new Error(
      'Child PR verification is ambiguous; reconcile provider evidence before selecting the output',
    );
  if (typeof verified === 'string') return null;
  const resource = await input.resources.findByExternalKey(verified.externalKey);
  if (
    resource === null ||
    resource.kind !== BuiltInResourceKind.PullRequest ||
    verified.revision !== revision ||
    resource.primaryCorrelationConflict !== undefined
  )
    return null;
  return resource;
}

async function qualifyingChange(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput,
) {
  const runs = (await input.runs()).filter(
    (run) =>
      run.workflowInstanceId === child.workflowInstanceId &&
      run.status === RunStatus.Succeeded &&
      child.acceptedOutcomes.includes(run.activationId),
  );
  const latest = reportedChange(runs, output.name);
  if (latest === undefined) return null;
  // Judge the PR against the latest implementation head so a revision run need not
  // repeat the report; the provider must confirm the PR now points there.
  const run = runs.filter((entry) => entry.workspace?.mode === WorkspaceMode.Branch).at(-1);
  const source = run === undefined ? undefined : runSource(run);
  if (run === undefined || source === undefined) return null;
  const { assignment, branch, revision } = source;
  const resource = await verifiedChange(input, latest.report, source);
  if (resource === null) return null;
  if (!(await hasOutputAuthority(input, child, output, resource.resourceId, revision))) return null;
  return {
    name: output.name,
    reference: {
      workItemId: child.workItemId,
      resourceId: resource.resourceId,
      repositoryResourceId: assignment.resourceId,
      revision,
      branch,
      pullRequestBase: assignment.pullRequestBase,
      runId: run.runId,
    },
  };
}

async function hasOutputAuthority(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput,
  id: Parameters<ResourceService['get']>[0],
  revision: string,
): Promise<boolean> {
  const owner = await input.resources.primaryCorrelation(id);
  if (
    owner?.workItemId !== child.workItemId ||
    owner.role !== ResourceCorrelationRole.Primary ||
    owner.provenance !== ResourceCorrelationProvenance.AgentReported
  )
    return false;
  const authority = await input.pullRequests.decideAuthority(child.workItemId, {
    target: { resourceId: id },
    requireAcceptedReview: output.requireReview ?? true,
    requireChecks: output.requireChecks ?? true,
  });
  if (!authority.allowed || authority.revision !== revision) return false;
  return true;
}

function runSource(run: RunView) {
  const assignment = run.repositoryAssignment;
  const branch = run.workspace?.branch;
  const revision = run.workspaceRevision;
  if (assignment === undefined || branch === undefined || revision === undefined) return undefined;
  return { assignment, branch, revision };
}
