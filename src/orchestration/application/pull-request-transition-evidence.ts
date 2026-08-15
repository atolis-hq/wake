import {
  ActivityEventType,
  ActivityResourceRole,
  PullRequestCheckState,
  PullRequestState,
  selectActivityEvent,
  selectPrimaryPullRequest,
  type ActivityEvent,
  type PullRequestService,
  type PullRequestView,
} from '../../activities/index.js';
import type { CompiledResourceTransition } from '../contracts/config.js';
import type {
  ResourceTransitionEvidence,
  ResourceTransitionEvidenceInput,
  ResourceTransitionEvidenceResolution,
  ResourceTransitionFact,
} from './resource-transition-evidence.js';

const triggers = [
  ActivityEventType.PrReviewAccepted,
  ActivityEventType.PrStateChanged,
  ActivityEventType.PrChecksChanged,
];

export function createPullRequestTransitionEvidence(
  pullRequests: PullRequestService,
): ResourceTransitionEvidence {
  return {
    triggers,
    async resolve({
      workItemId,
      transitions,
      fact,
    }: ResourceTransitionEvidenceInput): Promise<ResourceTransitionEvidenceResolution | null> {
      const input = await pullRequests.authorityInput(workItemId);
      const selected = selectPrimaryPullRequest(input, workItemId);
      if (selected === null) return null;
      const resourceId = selected.pullRequest.resourceId;

      const candidates =
        fact === undefined ? await pullRequests.factsFor(resourceId) : scoped(fact, resourceId);
      if (candidates.length === 0) return null;

      const authorized = (
        await pullRequests.decideAuthority(workItemId, {
          target: ActivityResourceRole.Primary,
          requireAcceptedReview: true,
          requireChecks: false,
        })
      ).allowed;

      return firstMatch(candidates, transitions, selected.pullRequest, authorized);
    },
  };
}

// A live fact carries its own resource stream; a fact about another work
// item's resource is not evidence for this instance's transitions.
function scoped(
  fact: ResourceTransitionFact,
  resourceId: PullRequestView['resourceId'],
): readonly ActivityEvent[] {
  const activity = selectActivityEvent(fact);
  return activity !== null && activity.stream.id === resourceId ? [activity] : [];
}

function firstMatch(
  candidates: readonly ActivityEvent[],
  transitions: readonly CompiledResourceTransition[],
  pullRequest: PullRequestView,
  authorized: boolean,
): ResourceTransitionEvidenceResolution | null {
  for (const candidate of candidates) {
    const transition = transitions.find((entry) =>
      matchesPrimaryPullRequestTransition(entry, candidate, pullRequest, authorized),
    );
    if (transition !== undefined) return { transition, evidenceId: candidate.eventId };
  }
  return null;
}

// The closed V1 event union is intentionally matched exhaustively here.
// eslint-disable-next-line complexity
function matchesPrimaryPullRequestTransition(
  transition: CompiledResourceTransition,
  event: ActivityEvent,
  pullRequest: PullRequestView,
  authorized: boolean,
): boolean {
  if (transition.event !== event.eventType) return false;
  if (event.eventType === ActivityEventType.PrReviewAccepted)
    return event.payload.revision === pullRequest.headRevision && authorized;
  if (event.eventType === ActivityEventType.PrStateChanged)
    return (
      transition.where !== undefined &&
      'state' in transition.where &&
      transition.where.state === event.payload.state &&
      event.payload.state === PullRequestState.Merged &&
      pullRequest.state === PullRequestState.Merged
    );
  if (event.eventType !== ActivityEventType.PrChecksChanged) return false;
  return (
    transition.where !== undefined &&
    'checks' in transition.where &&
    transition.where.checks === event.payload.checks &&
    event.payload.checks === PullRequestCheckState.Failing &&
    pullRequest.checks === PullRequestCheckState.Failing
  );
}
