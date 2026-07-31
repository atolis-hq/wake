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
    target: 'primary',
    requireAcceptedReview: true,
    requireChecks: true,
  },
): PullRequestAuthorityDecision {
  if (input.work === null) return denied('missing-resource');
  const resource = selectResource(input, input.work.workItemId, options.target);
  if (isDenial(resource)) return resource;
  const pullRequest = selectPullRequest(input, resource, input.work.workItemId);
  if (isDenial(pullRequest)) return pullRequest;
  if (pullRequest.state !== 'open') return denied('closed');
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
  const primary = resource.correlations.filter((correlation) => correlation.role === 'primary');
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
      (target === 'primary' || entry.resource.resourceId === target.resourceId),
  );
  if (resources.length === 0) return denied('missing-resource');
  if (resources.length !== 1) return denied('ambiguous-resource');
  const resource = resources[0]!;
  return hasPrimaryCorrelationConflict(resource, workItemId)
    ? denied('correlation-conflict')
    : resource;
}

function isPrimaryPullRequest(resource: PullRequestResourceView, workItemId: string): boolean {
  if (resource.resource.kind !== 'pull-request') return false;
  return resource.correlations.some(
    (correlation) => correlation.role === 'primary' && correlation.workItemId === workItemId,
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
  if (pullRequests.length === 0) return denied('missing-resource');
  return pullRequests.length === 1 ? pullRequests[0]! : denied('ambiguous-resource');
}

function reviewAuthority(
  pullRequest: PullRequestView,
  signals: readonly AcceptedReviewSignalView[],
): Denial | null {
  const accepted = pullRequest.acceptedReview;
  if (accepted === undefined || accepted.revision !== pullRequest.headRevision) {
    if (hasCurrentUntrustedSignal(pullRequest, signals)) return denied('untrusted-actor');
    return denied('stale-approval');
  }
  const signal = signals.find((candidate) => matchesAcceptedReview(candidate, pullRequest));
  return signal?.trusted === true ? null : denied('untrusted-actor');
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
  if (pullRequest.checks === 'unknown' || pullRequest.checks === 'pending')
    return denied('checks-pending');
  return pullRequest.checks === 'failing' ? denied('checks-failing') : null;
}

type Denial = Extract<PullRequestAuthorityDecision, { readonly allowed: false }>;

function isDenial<Value extends object>(value: Value | Denial): value is Denial {
  return 'allowed' in value;
}

function denied(reason: Denial['reason']): Denial {
  return { allowed: false, reason } as const;
}
