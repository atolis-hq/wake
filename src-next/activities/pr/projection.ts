import type { ProjectionDefinition } from '../../kernel/index.js';
import { isResourceStream } from '../../resources/index.js';
import { ActivityEventType, selectActivityEvent, type ActivityEvent } from '../contracts/events.js';
import type { AcceptedReviewSignalView, PullRequestView } from './contracts.js';

export const pullRequestProjection: ProjectionDefinition<PullRequestView | null> = {
  name: 'activities-pr',
  select(event) {
    const owned = selectActivityEvent(event);
    return owned !== null && isResourceStream(owned.stream) ? { key: owned.stream.id } : null;
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectActivityEvent(event);
    if (owned === null || !isResourceStream(owned.stream)) return previous;
    return projectPullRequest(previous, owned);
  },
};

export const acceptedReviewSignalProjection: ProjectionDefinition<
  readonly AcceptedReviewSignalView[]
> = {
  name: 'activities-pr-accepted-signals',
  select(event) {
    const owned = selectActivityEvent(event);
    return owned !== null && isResourceStream(owned.stream) ? { key: owned.stream.id } : null;
  },
  initial: () => [],
  project(previous, event) {
    const owned = selectActivityEvent(event);
    if (owned === null || !isResourceStream(owned.stream)) return previous;
    return projectAcceptedReviewSignal(previous, owned);
  },
};

export const activityProjectionDefinitions: readonly ProjectionDefinition[] = [
  pullRequestProjection,
  acceptedReviewSignalProjection,
];

function clearReview(view: PullRequestView): PullRequestView {
  const copy = { ...view };
  delete copy.acceptedReview;
  return copy;
}

// A new revision invalidates prior review and prior changed-file evidence;
// the projected event payload re-supplies changedFiles only if the provider
// reported it for this new revision.
function clearRevisionEvidence(view: PullRequestView): PullRequestView {
  const copy = { ...view };
  delete copy.acceptedReview;
  delete copy.changedFiles;
  return copy;
}

function projectPullRequest(
  previous: PullRequestView | null,
  event: ActivityEvent,
): PullRequestView | null {
  switch (event.eventType) {
    case ActivityEventType.PrDiscovered:
      return { resourceId: event.stream.id, ...event.payload };
    case ActivityEventType.PrRevisionChanged:
      return previous === null
        ? previous
        : { ...clearRevisionEvidence(previous), ...event.payload };
    case ActivityEventType.PrStateChanged:
      return previous === null ? previous : { ...previous, state: event.payload.state };
    case ActivityEventType.PrChecksChanged:
      return previous === null ? previous : { ...previous, checks: event.payload.checks };
    case ActivityEventType.PrReviewAccepted:
      return previous === null
        ? previous
        : {
            ...previous,
            acceptedReview: {
              revision: event.payload.revision,
              actorId: event.payload.actorId,
              acceptedEventId: event.eventId,
            },
          };
    case ActivityEventType.PrReviewChangesRequested:
      return previous === null ? previous : clearReview(previous);
    default:
      return ignorePullRequestEvent(previous, event);
  }
}

function ignorePullRequestEvent(
  previous: PullRequestView | null,
  event: Exclude<
    ActivityEvent,
    {
      readonly eventType:
        | typeof ActivityEventType.PrDiscovered
        | typeof ActivityEventType.PrRevisionChanged
        | typeof ActivityEventType.PrStateChanged
        | typeof ActivityEventType.PrChecksChanged
        | typeof ActivityEventType.PrReviewAccepted
        | typeof ActivityEventType.PrReviewChangesRequested;
    }
  >,
): PullRequestView | null {
  switch (event.eventType) {
    case ActivityEventType.ReviewAcceptanceSignalRecorded:
    case ActivityEventType.PrReviewRejected:
    case ActivityEventType.PrMergeDenied:
    case ActivityEventType.PrApproveDenied:
    case ActivityEventType.PrMergeAuthorized:
    case ActivityEventType.PrApproveRequested:
    case ActivityEventType.PrMergeRequested:
    case ActivityEventType.PrApproveDecisionClaimed:
    case ActivityEventType.PrMergeDecisionClaimed:
      return previous;
    default:
      return assertNever(event);
  }
}

function projectAcceptedReviewSignal(
  previous: readonly AcceptedReviewSignalView[],
  event: ActivityEvent,
): readonly AcceptedReviewSignalView[] {
  switch (event.eventType) {
    case ActivityEventType.ReviewAcceptanceSignalRecorded: {
      const signal = { resourceId: event.stream.id, ...event.payload };
      return previous.some((candidate) => candidate.acceptedEventId === signal.acceptedEventId)
        ? previous
        : [...previous, signal];
    }
    case ActivityEventType.PrMergeDenied:
    case ActivityEventType.PrApproveDenied:
    case ActivityEventType.PrApproveDecisionClaimed:
    case ActivityEventType.PrMergeDecisionClaimed:
      return previous;
    default:
      return ignoreAcceptedSignalFact(previous, event);
  }
}

function ignoreAcceptedSignalFact(
  previous: readonly AcceptedReviewSignalView[],
  event: Exclude<
    ActivityEvent,
    {
      readonly eventType:
        | typeof ActivityEventType.ReviewAcceptanceSignalRecorded
        | typeof ActivityEventType.PrMergeDenied
        | typeof ActivityEventType.PrApproveDenied
        | typeof ActivityEventType.PrApproveDecisionClaimed
        | typeof ActivityEventType.PrMergeDecisionClaimed;
    }
  >,
): readonly AcceptedReviewSignalView[] {
  switch (event.eventType) {
    case ActivityEventType.PrDiscovered:
    case ActivityEventType.PrRevisionChanged:
    case ActivityEventType.PrStateChanged:
    case ActivityEventType.PrChecksChanged:
    case ActivityEventType.PrReviewAccepted:
    case ActivityEventType.PrReviewChangesRequested:
    case ActivityEventType.PrReviewRejected:
    case ActivityEventType.PrMergeAuthorized:
    case ActivityEventType.PrApproveRequested:
    case ActivityEventType.PrMergeRequested:
      return previous;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Activity event: ${JSON.stringify(value)}`);
}
