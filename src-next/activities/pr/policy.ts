import { ActivityResourceRole } from '../contracts/vocabulary.js';
import { PullRequestCheckState, PullRequestDenialCode, PullRequestState } from './vocabulary.js';
import type {
  AcceptedReviewSignalView,
  PullRequestAuthorityDecision,
  PullRequestAuthorityInput,
  PullRequestAuthorityOptions,
  PullRequestResourceView,
  PullRequestTarget,
  PullRequestView,
} from './contracts.js';
import { ActivityEventType } from '../contracts/events.js';

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
  if (options.requireAcceptedReview) {
    const review = reviewAuthority(pullRequest, input.acceptedSignals);
    if (review !== null) return review;
  }
  if (options.requireChecks) {
    const checks = checkAuthority(pullRequest);
    if (checks !== null) return checks;
  }
  return { allowed: true, resourceId: pullRequest.resourceId, revision: pullRequest.headRevision };
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
  if (resource.resource.kind !== 'pull-request') return false;
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

function checkAuthority(pullRequest: PullRequestView): Denial | null {
  if (
    pullRequest.checks === PullRequestCheckState.Unknown ||
    pullRequest.checks === PullRequestCheckState.Pending
  )
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
