import {
  decidePullRequestOutputAuthority,
  PullRequestState,
  type PullRequestService,
} from '../../activities/index.js';
import { RunStatus, WorkspaceMode } from '../../execution/index.js';
import type {
  DelegationArtifacts,
  DelegationPrerequisite,
  WorkflowInstanceView,
} from '../../orchestration/index.js';
import { DelegationPrerequisiteCondition as Condition } from '../../orchestration/index.js';
import {
  ResourceCorrelationProvenance,
  ResourceCorrelationRole,
  type ResourceService,
} from '../../resources/index.js';
import { reportedChange } from './delegation-output-claims.js';
import { deliveryReadyRequirements, outputAuthorityReason } from './delegation-output-review.js';
import {
  hasSuccessfulOutcome,
  reviewSource,
  runSource,
  verifiedReviewChange,
  type ChangeOutput,
  type OutputDependencies,
} from './delegation-output-source.js';

/** Select exact provider-verified results owned by the producing child. */
export function createDelegationOutputs(input: OutputDependencies): DelegationArtifacts {
  return {
    ...input.artifacts,
    async reviewSubject(child, output) {
      if (!('kind' in output)) return null;
      return qualifyingChange(input, child, output, Condition.PushedChange, true);
    },
    async runActivation(runId) {
      return (await input.runs()).find((run) => run.runId === runId)?.activationId;
    },
    async prerequisiteOutput(child, output, condition, blocked) {
      if (
        'path' in output &&
        (condition === Condition.AcceptedOutput || condition === Condition.DeliveryReady)
      ) {
        return (await input.artifacts.qualifyingOutputs(child, [output]))?.[0] ?? null;
      }
      if (!('kind' in output)) return null;
      return qualifyingChange(
        blocked === undefined ? input : { ...input, blocked },
        child,
        output,
        condition,
      );
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

async function qualifyingChange(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput,
  condition?: DelegationPrerequisite['condition'],
  currentHead = false,
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
  const original = run === undefined ? undefined : runSource(run, output.name);
  if (run === undefined || original === undefined) return null;
  const source = await reviewSource(
    input,
    child,
    output,
    { ...latest, run },
    original,
    currentHead,
  );
  const { assignment, branch, revision } = source;
  const resource = await verifiedReviewChange(
    input,
    child,
    latest.report,
    source,
    original.revision,
    currentHead,
  );
  if (resource === null) return null;
  const qualified = await qualifyingObservation(
    input,
    child,
    output,
    resource.resourceId,
    revision,
    { condition, currentHead },
  );
  if (qualified === null) return null;
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
      baseRevision: qualified.baseRevision,
      ...(qualified.state === PullRequestState.Merged ? { merged: true as const } : {}),
    },
  };
}

async function qualifyingObservation(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput,
  id: Parameters<PullRequestService['get']>[0],
  revision: string,
  {
    condition,
    currentHead,
  }: {
    readonly condition: DelegationPrerequisite['condition'] | undefined;
    readonly currentHead: boolean;
  },
) {
  if (!(await ownsOutput(input, child, id))) {
    if (currentHead)
      throw new Error('Child PR identity mismatch: primary ownership could not be verified');
    return null;
  }
  const observed = await input.pullRequests.get(id);
  if (observed === null || observed.headRevision !== revision) return null;
  if (condition === Condition.MergedChange) {
    if (observed.state !== PullRequestState.Merged) return null;
  } else {
    const requirements =
      condition === Condition.DeliveryReady
        ? await deliveryReadyRequirements(input, child, revision)
        : condition === Condition.PushedChange
          ? { requireReview: false, requireChecks: false }
          : output;
    if (
      requirements === null ||
      !(await hasOutputAuthority(input, child, { ...output, ...requirements }, id, revision))
    )
      return null;
  }
  return observed;
}

async function hasOutputAuthority(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput & { readonly reviewFallbackReason?: string },
  id: Parameters<ResourceService['get']>[0],
  revision: string,
): Promise<boolean> {
  if (!(await ownsOutput(input, child, id))) return false;
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
  if (!authority.allowed) {
    input.blocked?.(
      outputAuthorityReason(
        authority.reason,
        options.requireAcceptedReview,
        output.reviewFallbackReason,
      ),
    );
    return false;
  }
  if (authority.revision !== revision) {
    input.blocked?.(
      [output.reviewFallbackReason, 'Output authority does not attest exact head ' + revision]
        .filter((reason) => reason !== undefined)
        .join('; '),
    );
    return false;
  }
  return true;
}

async function ownsOutput(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  id: Parameters<ResourceService['get']>[0],
) {
  const owner = await input.resources.primaryCorrelation(id);
  return (
    owner?.workItemId === child.workItemId &&
    owner.role === ResourceCorrelationRole.Primary &&
    owner.provenance === ResourceCorrelationProvenance.AgentReported
  );
}
