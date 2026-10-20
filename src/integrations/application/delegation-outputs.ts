import { z } from 'zod';
import {
  ActivityOutcomeKind,
  decidePullRequestOutputAuthority,
  PullRequestState,
  reportedArtifactSchema,
  type PullRequestService,
} from '../../activities/index.js';
import { RunStatus, WorkspaceMode, type RunView } from '../../execution/index.js';
import type {
  DelegationArtifacts,
  DelegationOutputKind,
  DelegationPrerequisite,
  WorkflowInstanceView,
} from '../../orchestration/index.js';
import { DelegationPrerequisiteCondition as Condition } from '../../orchestration/index.js';
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
    async prerequisiteOutput(child, output, condition) {
      if (
        'path' in output &&
        (condition === Condition.AcceptedOutput || condition === Condition.DeliveryReady)
      ) {
        return (await input.artifacts.qualifyingOutputs(child, [output]))?.[0] ?? null;
      }
      if (!('kind' in output)) return null;
      return qualifyingChange(input, child, output, condition);
    },
    async qualifyingOutputs(child, outputs) {
      const references: NonNullable<Awaited<ReturnType<DelegationArtifacts['qualifyingOutputs']>>> =
        [];
      for (const output of outputs) {
        if ('path' in output) {
          const selected = await input.artifacts.qualifyingOutputs(child, [output]);
          if (selected === null) {
            if (output.required !== false) return null;
          } else references.push(...selected);
          continue;
        }
        const change = await qualifyingChange(input, child, output);
        if (change === null) {
          if (output.required !== false) return null;
          continue;
        }
        if (
          references.some(
            (entry) =>
              'resourceId' in entry.reference &&
              entry.reference.resourceId === change.reference.resourceId,
          )
        )
          return null;
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
      if (
        data.success &&
        data.data.reportedArtifacts.filter((entry) => entry.name === name).length > 1
      )
        throw new Error('Duplicate named change report');
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
  condition?: DelegationPrerequisite['condition'],
) {
  const runs = (await input.runs()).filter(
    (run) =>
      run.workflowInstanceId === child.workflowInstanceId &&
      run.status === RunStatus.Succeeded &&
      hasSuccessfulOutcome(run) &&
      child.acceptedOutcomes.includes(run.activationId),
  );
  const latest = reportedChange(runs, output.name);
  if (latest === undefined) return null;
  // A revision run may omit the report, but only this output's own branch may refresh it.
  const run = runs
    .filter(
      (entry) =>
        entry.workspace?.mode === WorkspaceMode.Branch &&
        (latest.run.workspace?.changeOutputs === undefined ||
          entry.changeOutputs?.some((source) => source.name === output.name) === true),
    )
    .at(-1);
  const source = run === undefined ? undefined : runSource(run, output.name);
  if (run === undefined || source === undefined) return null;
  const { assignment, branch, revision } = source;
  const resource = await verifiedChange(input, latest.report, source);
  if (resource === null) return null;
  const observed = await qualifyingObservation(
    input,
    child,
    output,
    resource.resourceId,
    revision,
    condition,
  );
  if (observed === null) return null;
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
      baseRevision: observed.baseRevision,
      ...(observed.state === PullRequestState.Merged ? { merged: true as const } : {}),
    },
  };
}

async function qualifyingObservation(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput,
  id: Parameters<PullRequestService['get']>[0],
  revision: string,
  condition: DelegationPrerequisite['condition'] | undefined,
) {
  const owner = await input.resources.primaryCorrelation(id);
  if (
    owner?.workItemId !== child.workItemId ||
    owner.role !== ResourceCorrelationRole.Primary ||
    owner.provenance !== ResourceCorrelationProvenance.AgentReported
  )
    return null;
  const observed = await input.pullRequests.get(id);
  if (observed === null || observed.headRevision !== revision) return null;
  if (condition === Condition.MergedChange) {
    if (observed.state !== PullRequestState.Merged) return null;
  } else if (
    !(await hasOutputAuthority(
      input,
      child,
      condition === Condition.PushedChange
        ? { ...output, requireReview: false, requireChecks: false }
        : output,
      id,
      revision,
    ))
  )
    return null;
  return observed;
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
  const options = {
    target: { resourceId: id },
    requireAcceptedReview: output.requireReview ?? true,
    requireChecks: output.requireChecks ?? true,
  };
  const observed = await input.pullRequests.get(id);
  const authority =
    observed?.state === PullRequestState.Merged
      ? decidePullRequestOutputAuthority(
          await input.pullRequests.authorityInput(child.workItemId),
          options,
        )
      : await input.pullRequests.decideAuthority(child.workItemId, options);
  if (!authority.allowed || authority.revision !== revision) return false;
  return true;
}

function runSource(run: RunView, name?: string) {
  if (run.workspace?.changeOutputs !== undefined) {
    const output = run.changeOutputs?.find((entry) => entry.name === name);
    return output === undefined
      ? undefined
      : {
          assignment: output.repository,
          branch: output.branch,
          revision: output.revision,
        };
  }
  const assignment = run.repositoryAssignment;
  const branch = run.workspace?.branch;
  const revision = run.workspaceRevision;
  if (assignment === undefined || branch === undefined || revision === undefined) return undefined;
  return { assignment, branch, revision };
}

function hasSuccessfulOutcome(run: RunView): boolean {
  return (
    run.outcome !== undefined &&
    run.outcome.kind !== ActivityOutcomeKind.Failed &&
    run.outcome.kind !== ActivityOutcomeKind.Blocked &&
    run.outcome.kind !== ActivityOutcomeKind.Rejected
  );
}
