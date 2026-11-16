import {
  ActivityOutcomeKind,
  PullRequestState,
  type PullRequestService,
} from '../../activities/index.js';
import type { RunView } from '../../execution/index.js';
import type {
  DelegationArtifacts,
  DelegationOutputKind,
  WorkflowInstanceView,
} from '../../orchestration/index.js';
import { BuiltInResourceKind, resourceId, type ResourceService } from '../../resources/index.js';
import { ArtifactVerificationResult } from '../contracts/artifact-vocabulary.js';
import type { ProviderInstance } from '../contracts/provider.js';
import type { reportedChange } from './delegation-output-claims.js';
import { refreshedReviewSubject, type DelegationReviewPolicy } from './delegation-output-review.js';

export type ChangeOutput = Extract<
  Parameters<DelegationArtifacts['qualifyingOutputs']>[1][number],
  { readonly kind: typeof DelegationOutputKind.Change }
>;

export interface OutputDependencies {
  readonly blocked?: (reason: string) => void;
  readonly reviewPolicy?: DelegationReviewPolicy;
  readonly artifacts: DelegationArtifacts;
  readonly resources: ResourceService;
  readonly pullRequests: PullRequestService;
  readonly runs: () => Promise<readonly RunView[]>;
  readonly providers: () => Promise<readonly ProviderInstance[]>;
}

export async function verifiedChange(
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

export function runSource(run: RunView, name?: string) {
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

export function hasSuccessfulOutcome(run: RunView): boolean {
  return (
    run.outcome !== undefined &&
    run.outcome.kind !== ActivityOutcomeKind.Failed &&
    run.outcome.kind !== ActivityOutcomeKind.Blocked &&
    run.outcome.kind !== ActivityOutcomeKind.Rejected
  );
}

export async function reviewSource(
  input: OutputDependencies,
  child: WorkflowInstanceView,
  output: ChangeOutput,
  latest: NonNullable<ReturnType<typeof reportedChange>>,
  original: NonNullable<ReturnType<typeof runSource>>,
  currentHead: boolean,
) {
  let source = original;
  const refresh = await refreshedReviewSubject(input, child);
  const observedResource = await input.resources.findByExternalKey(latest.report.externalKey);
  const observed =
    observedResource === null ? null : await input.pullRequests.get(observedResource.resourceId);
  if (currentHead) {
    if (observed === null || observed.state !== PullRequestState.Open) return undefined;
    source = { ...source, revision: observed.headRevision };
  } else if (
    refresh?.name === output.name &&
    'revision' in refresh.reference &&
    refresh.reference.runId === latest.run.runId &&
    refresh.reference.branch === source.branch &&
    refresh.reference.resourceId === observedResource?.resourceId
  ) {
    source = { ...source, revision: refresh.reference.revision };
  }
  return source;
}
