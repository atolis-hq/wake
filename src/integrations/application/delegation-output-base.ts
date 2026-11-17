import { PullRequestState, type PullRequestService } from '../../activities/index.js';
import type { DelegationInputs } from '../../orchestration/index.js';
import {
  BuiltInResourceKind,
  resourceId,
  type ExternalResourceKey,
  type ResourceService,
} from '../../resources/index.js';
import type { ProviderInstance } from '../contracts/provider.js';

type ConsumedChange = Extract<
  DelegationInputs['consumed'][number]['reference'],
  { readonly resourceId: string }
>;

export interface BaseLineageDependencies {
  readonly resources: ResourceService;
  readonly pullRequests: PullRequestService;
  /** Latest journaled consumption receipt for a delegated child. */
  readonly inputs?: (childWorkItemId: string) => Promise<DelegationInputs | undefined>;
}

/**
 * Bases a stacked child PR may target beyond its recorded base. Merging an upstream PR
 * collapses the stack onto that upstream's own recorded base, so each step needs the
 * child's receipt naming the upstream branch as its base, a merged observation, and
 * provider evidence that the upstream PR targets the next base.
 */
export async function* collapsedPullRequestBases(
  input: BaseLineageDependencies,
  provider: ProviderInstance,
  repository: ExternalResourceKey,
  child: { readonly workItemId: string; readonly repositoryResourceId: string },
  recordedBase: string,
): AsyncGenerator<string> {
  const seen = new Set([child.workItemId]);
  const bases = new Set([recordedBase]);
  let current = { workItemId: child.workItemId, base: recordedBase };
  for (;;) {
    const upstream = (await input.inputs?.(current.workItemId))?.consumed
      .map((entry) => entry.reference)
      .find(
        (reference): reference is ConsumedChange =>
          'resourceId' in reference &&
          reference.branch === current.base &&
          reference.repositoryResourceId === child.repositoryResourceId,
      );
    if (
      upstream === undefined ||
      seen.has(upstream.workItemId) ||
      bases.has(upstream.pullRequestBase) ||
      !(await mergedInto(input, provider, repository, upstream))
    )
      return;
    seen.add(upstream.workItemId);
    bases.add(upstream.pullRequestBase);
    yield upstream.pullRequestBase;
    current = { workItemId: upstream.workItemId, base: upstream.pullRequestBase };
  }
}

async function mergedInto(
  input: BaseLineageDependencies,
  provider: ProviderInstance,
  repository: ExternalResourceKey,
  upstream: ConsumedChange,
) {
  const id = resourceId(upstream.resourceId);
  const observed = await input.pullRequests.get(id);
  if (observed?.state !== PullRequestState.Merged) return false;
  const pullRequest = await input.resources.get(id);
  if (pullRequest?.kind !== BuiltInResourceKind.PullRequest) return false;
  const verified = await provider.verifyArtifact(
    BuiltInResourceKind.PullRequest,
    pullRequest.externalKey,
    { repository, workspaceBranch: upstream.branch, pullRequestBase: upstream.pullRequestBase },
  );
  return (
    typeof verified !== 'string' &&
    verified.externalKey.adapter === pullRequest.externalKey.adapter &&
    verified.externalKey.key === pullRequest.externalKey.key
  );
}
