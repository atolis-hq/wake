import { BuiltInResourceCapability } from '../../resources/index.js';
import { ActivityEventType } from '../contracts/events.js';
import { ActivityResourceRole } from '../contracts/vocabulary.js';
import { isPullRequestLikeResource } from './capability.js';
import type {
  AcceptedReviewSignalView,
  PullRequestAuthorityDecision,
  PullRequestAuthorityInput,
  PullRequestAuthorityOptions,
  PullRequestMergePolicy,
  PullRequestResourceView,
  PullRequestTarget,
  PullRequestView,
} from './contracts.js';
import { PullRequestCheckState, PullRequestDenialCode, PullRequestState } from './vocabulary.js';

export function decidePullRequestAuthority(
  input: PullRequestAuthorityInput,
  options: PullRequestAuthorityOptions = {
    target: ActivityResourceRole.Primary,
    requireAcceptedReview: true,
    requireChecks: true,
  },
): PullRequestAuthorityDecision {
  if (input.work === null) return denied(PullRequestDenialCode.MissingResource);
  const resource = selectResource(input, input.work.workItemId, options.target);
  if (isDenial(resource)) return resource;
  const pullRequest = selectPullRequest(input, resource, input.work.workItemId);
  if (isDenial(pullRequest)) return pullRequest;
  if (pullRequest.state !== PullRequestState.Open) return denied(PullRequestDenialCode.Closed);
  const authority = finalizeAuthority(input, resource, pullRequest, options);
  if (authority !== null) return authority;
  return { allowed: true, resourceId: pullRequest.resourceId, revision: pullRequest.headRevision };
}

function finalizeAuthority(
  input: PullRequestAuthorityInput,
  resource: PullRequestResourceView,
  pullRequest: PullRequestView,
  options: PullRequestAuthorityOptions,
): Denial | null {
  if (options.requireAcceptedReview) {
    const review = reviewAuthority(pullRequest, input.acceptedSignals);
    if (review !== null) return review;
  }
  if (options.requireChecks) {
    const checks = checkAuthority(pullRequest, options.allowPendingChecks ?? false);
    if (checks !== null) return checks;
  }
  if (options.mergePolicy !== undefined) {
    const files = changedFilesAuthority(pullRequest, resource, options.mergePolicy);
    if (files !== null) return files;
  }
  return null;
}

export function createPullRequestMergeDenial(decision: PullRequestAuthorityDecision): {
  readonly eventType: typeof ActivityEventType.PrMergeDenied;
  readonly payload: { readonly reason: string };
} | null {
  if (decision.allowed) return null;
  return {
    eventType: ActivityEventType.PrMergeDenied,
    payload: { reason: decision.reason },
  };
}

function hasPrimaryCorrelationConflict(
  resource: PullRequestResourceView,
  workItemId: string,
): boolean {
  const primary = resource.correlations.filter(
    (correlation) => correlation.role === ActivityResourceRole.Primary,
  );
  return (
    resource.resource.primaryCorrelationConflict !== undefined ||
    primary.length !== 1 ||
    primary[0]!.workItemId !== workItemId
  );
}

// Happy-path wrapper over the same primary-resource and pull-request
// selection rules `decidePullRequestAuthority` uses, for callers that only
// need the selected pair and not a specific denial code.
export function selectPrimaryPullRequest(
  input: PullRequestAuthorityInput,
  workItemId: string,
): { readonly resource: PullRequestResourceView; readonly pullRequest: PullRequestView } | null {
  const resource = selectResource(input, workItemId, ActivityResourceRole.Primary);
  if (isDenial(resource)) return null;
  const pullRequest = selectPullRequest(input, resource, workItemId);
  return isDenial(pullRequest) ? null : { resource, pullRequest };
}

function selectResource(
  input: PullRequestAuthorityInput,
  workItemId: string,
  target: PullRequestTarget,
): PullRequestResourceView | Denial {
  const resources = input.resources.filter(
    (entry) =>
      isPrimaryPullRequest(entry, workItemId) &&
      (target === ActivityResourceRole.Primary || entry.resource.resourceId === target.resourceId),
  );
  if (resources.length === 0) return denied(PullRequestDenialCode.MissingResource);
  if (resources.length !== 1) return denied(PullRequestDenialCode.AmbiguousResource);
  const resource = resources[0]!;
  return hasPrimaryCorrelationConflict(resource, workItemId)
    ? denied(PullRequestDenialCode.CorrelationConflict)
    : resource;
}

function isPrimaryPullRequest(resource: PullRequestResourceView, workItemId: string): boolean {
  if (!isPullRequestLikeResource(resource.resource.capabilities)) return false;
  return resource.correlations.some(
    (correlation) =>
      correlation.role === ActivityResourceRole.Primary && correlation.workItemId === workItemId,
  );
}

function selectPullRequest(
  input: PullRequestAuthorityInput,
  resource: PullRequestResourceView,
  workItemId: string,
): PullRequestView | Denial {
  const pullRequests = input.pullRequests.filter(
    (view) => view.resourceId === resource.resource.resourceId && view.workItemId === workItemId,
  );
  if (pullRequests.length === 0) return denied(PullRequestDenialCode.MissingResource);
  return pullRequests.length === 1
    ? pullRequests[0]!
    : denied(PullRequestDenialCode.AmbiguousResource);
}

function reviewAuthority(
  pullRequest: PullRequestView,
  signals: readonly AcceptedReviewSignalView[],
): Denial | null {
  const accepted = pullRequest.acceptedReview;
  if (accepted === undefined || accepted.revision !== pullRequest.headRevision) {
    if (hasCurrentUntrustedSignal(pullRequest, signals))
      return denied(PullRequestDenialCode.UntrustedActor);
    return denied(PullRequestDenialCode.StaleApproval);
  }
  const signal = signals.find((candidate) => matchesAcceptedReview(candidate, pullRequest));
  return signal?.trusted === true ? null : denied(PullRequestDenialCode.UntrustedActor);
}

function hasCurrentUntrustedSignal(
  pullRequest: PullRequestView,
  signals: readonly AcceptedReviewSignalView[],
): boolean {
  return signals.some(
    (signal) =>
      signal.resourceId === pullRequest.resourceId &&
      signal.revision === pullRequest.headRevision &&
      !signal.trusted,
  );
}

function matchesAcceptedReview(
  candidate: AcceptedReviewSignalView,
  pullRequest: PullRequestView,
): boolean {
  const accepted = pullRequest.acceptedReview;
  return (
    accepted !== undefined &&
    candidate.resourceId === pullRequest.resourceId &&
    candidate.acceptedEventId === accepted.acceptedEventId &&
    candidate.revision === accepted.revision &&
    candidate.actorId === accepted.actorId
  );
}

function changedFilesAuthority(
  pullRequest: PullRequestView,
  resource: PullRequestResourceView,
  policy: PullRequestMergePolicy,
): Denial | null {
  const configured = policy.maxFilesChanged !== undefined || policy.blockedPaths.length > 0;
  if (!configured) return null;
  const changedFiles = resource.resource.capabilities.includes(
    BuiltInResourceCapability.ChangedFiles,
  )
    ? pullRequest.changedFiles
    : undefined;
  if (changedFiles === undefined) return denied(PullRequestDenialCode.ChangedFilesUnavailable);
  if (policy.maxFilesChanged !== undefined && changedFiles.length > policy.maxFilesChanged)
    return denied(PullRequestDenialCode.TooManyFilesChanged);
  return policy.blockedPaths.some((blocked) => changedFiles.includes(blocked))
    ? denied(PullRequestDenialCode.BlockedPathChanged)
    : null;
}

function checkAuthority(pullRequest: PullRequestView, allowPendingChecks: boolean): Denial | null {
  if (pullRequest.checks === PullRequestCheckState.Unknown)
    return denied(PullRequestDenialCode.ChecksPending);
  if (pullRequest.checks === PullRequestCheckState.Pending && !allowPendingChecks)
    return denied(PullRequestDenialCode.ChecksPending);
  return pullRequest.checks === PullRequestCheckState.Failing
    ? denied(PullRequestDenialCode.ChecksFailing)
    : null;
}

type Denial = Extract<PullRequestAuthorityDecision, { readonly allowed: false }>;

function isDenial<Value extends object>(value: Value | Denial): value is Denial {
  return 'allowed' in value;
}

function denied(reason: Denial['reason']): Denial {
  return { allowed: false, reason } as const;
}
