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
import {
  BuiltInResourceKind,
  resourceId,
  type ExternalResourceKey,
  type ResourceService,
  type ResourceView,
} from '../../resources/index.js';
import { ArtifactVerificationResult } from '../contracts/artifact-vocabulary.js';
import type { ProviderInstance } from '../contracts/provider.js';
import {
  collapsedPullRequestBases,
  type BaseLineageDependencies,
} from './delegation-output-base.js';
import type { reportedChange } from './delegation-output-claims.js';
import { refreshedReviewSubject, type DelegationReviewPolicy } from './delegation-output-review.js';

export type ChangeOutput = Extract<
  Parameters<DelegationArtifacts['qualifyingOutputs']>[1][number],
  { readonly kind: typeof DelegationOutputKind.Change }
>;

export interface OutputDependencies extends BaseLineageDependencies {
  readonly blocked?: (reason: string) => void;
  readonly reviewPolicy?: DelegationReviewPolicy;
  readonly artifacts: DelegationArtifacts;
  readonly resources: ResourceService;
  readonly pullRequests: PullRequestService;
  readonly runs: () => Promise<readonly RunView[]>;
  readonly providers: () => Promise<readonly ProviderInstance[]>;
}

type ChangeSource = NonNullable<ReturnType<typeof runSource>>;

type ReviewSource = ChangeSource & { readonly recovered: boolean };

type Report = NonNullable<ReturnType<typeof reportedChange>>['report'];

type Verified = Exclude<Awaited<ReturnType<ProviderInstance['verifyArtifact']>>, string>;

/**
 * Provider-verified PR resource for a child's recorded source, or the verification that failed.
 * Only a recovered review subject may follow a merged upstream's base: an older review attested
 * the diff against the recorded stacked base, not the retargeted one.
 */
export async function verifiedChange(
  input: OutputDependencies,
  child: Pick<WorkflowInstanceView, 'workItemId'>,
  report: Report,
  source: ReviewSource,
): Promise<{ readonly resource: ResourceView } | { readonly reason: string }> {
  const repository = await input.resources.get(resourceId(source.assignment.resourceId));
  if (repository === null) return { reason: 'repository resource is not tracked' };
  const provider = (await input.providers()).find(
    (entry) => entry.adapter === report.externalKey.adapter,
  );
  if (provider === undefined)
    return { reason: 'provider ' + report.externalKey.adapter + ' is not configured' };
  const confirmed = await confirmedPullRequest(input, child, report, source, {
    provider,
    repository: repository.externalKey,
  });
  if ('reason' in confirmed) return confirmed;
  const { verified } = confirmed;
  if (
    verified.externalKey.adapter !== report.externalKey.adapter ||
    verified.externalKey.key !== report.externalKey.key ||
    verified.revision !== source.revision
  )
    return { reason: 'provider evidence names a different PR or head than ' + source.revision };
  const resource = await input.resources.findByExternalKey(verified.externalKey);
  if (resource === null || resource.kind !== BuiltInResourceKind.PullRequest)
    return { reason: report.externalKey.key + ' is not a tracked pull-request resource' };
  if (resource.primaryCorrelationConflict !== undefined)
    return { reason: report.externalKey.key + ' has a conflicting primary correlation' };
  return { resource };
}

/** Tries the recorded base, then (for recovered subjects) each merged upstream base in order. */
async function confirmedPullRequest(
  input: OutputDependencies,
  child: Pick<WorkflowInstanceView, 'workItemId'>,
  report: Report,
  source: ReviewSource,
  target: { readonly provider: ProviderInstance; readonly repository: ExternalResourceKey },
): Promise<{ readonly verified: Verified } | { readonly reason: string }> {
  const { assignment, branch, revision, recovered } = source;
  const verify = async (pullRequestBase: string) => {
    const verified = await target.provider.verifyArtifact(
      BuiltInResourceKind.PullRequest,
      report.externalKey,
      {
        repository: target.repository,
        workspaceBranch: branch,
        workspaceRevision: revision,
        pullRequestBase,
      },
    );
    if (verified === ArtifactVerificationResult.Ambiguous)
      throw new Error(
        'Child PR verification is ambiguous; reconcile provider evidence before selecting the output',
      );
    return typeof verified === 'string' ? null : verified;
  };
  const bases = [assignment.pullRequestBase];
  const verified = await verify(assignment.pullRequestBase);
  if (verified !== null) return { verified };
  if (recovered)
    for await (const base of collapsedPullRequestBases(
      input,
      target.provider,
      target.repository,
      { workItemId: child.workItemId, repositoryResourceId: assignment.resourceId },
      assignment.pullRequestBase,
    )) {
      bases.push(base);
      const collapsed = await verify(base);
      if (collapsed !== null) return { verified: collapsed };
    }
  const hint = !recovered
    ? ' (a retargeted stack needs review recovery at its current head)'
    : bases.length === 1
      ? ' (no merged upstream base lineage)'
      : '';
  return {
    reason: `provider did not confirm ${report.externalKey.key} in ${target.repository.key} on branch ${branch} at head ${revision} targeting ${bases.join(' or ')}${hint}`,
  };
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
  original: ChangeSource,
  currentHead: boolean,
): Promise<ReviewSource> {
  let source: ReviewSource = { ...original, recovered: false };
  const refresh = await refreshedReviewSubject(input, child);
  const observedResource = await input.resources.findByExternalKey(latest.report.externalKey);
  const observed =
    observedResource === null ? null : await input.pullRequests.get(observedResource.resourceId);
  if (currentHead) {
    source = { ...source, revision: openReviewHead(observed), recovered: true };
  } else if (
    refresh?.name === output.name &&
    'revision' in refresh.reference &&
    refresh.reference.runId === latest.run.runId &&
    refresh.reference.branch === source.branch &&
    refresh.reference.resourceId === observedResource?.resourceId
  ) {
    source = { ...source, revision: refresh.reference.revision, recovered: true };
  }
  return source;
}

function openReviewHead(observed: Awaited<ReturnType<PullRequestService['get']>>) {
  if (observed === null || !observed.headRevision)
    throw new Error('Current provider head is not observed for the child PR');
  if (observed.state !== PullRequestState.Open)
    throw new Error('Child PR is not open for review recovery');
  return observed.headRevision;
}

export async function verifiedReviewChange(
  input: OutputDependencies,
  child: Pick<WorkflowInstanceView, 'workItemId'>,
  report: NonNullable<ReturnType<typeof reportedChange>>['report'],
  source: ReviewSource,
  attestedRevision: string,
  currentHead: boolean,
) {
  const verified = await verifiedChange(input, child, report, source);
  if ('reason' in verified) {
    const reason = 'Child PR identity mismatch: ' + verified.reason;
    if (currentHead) throw new Error(reason);
    input.blocked?.(reason);
    return null;
  }
  const { resource } = verified;
  if (source.revision === attestedRevision) return resource;
  const repository = await input.resources.get(resourceId(source.assignment.resourceId));
  const provider = (await input.providers()).find(
    (entry) => entry.adapter === report.externalKey.adapter,
  );
  const ancestry =
    repository === null
      ? null
      : await provider?.verifyRevisionAncestry?.(
          repository.externalKey,
          attestedRevision,
          source.revision,
        );
  if (ancestry === true) return resource;
  const reason =
    ancestry === false
      ? 'Current provider head is not a descendant of the attested revision'
      : 'Provider ancestry evidence is unavailable for the attested revision';
  if (currentHead) throw new Error(reason);
  input.blocked?.(reason);
  return null;
}
