import {
  ActivityEventType,
  ActivityResourceRole,
  PullRequestCheckState,
  PullRequestState,
  selectActivityEvent,
  type ActivityEvent,
  type PullRequestService,
} from '../../activities/index.js';
import type { EventJournal } from '../../kernel/index.js';
import type { CompiledEventTransition, TransitionTarget } from '../contracts/config.js';
import type { WorkflowInstanceView } from '../contracts/views.js';

export interface EventTransitionResolution {
  readonly evidenceId: string;
  readonly position: number;
  readonly target: TransitionTarget;
}

export interface EventTransitionResolver {
  resolve(
    workflow: WorkflowInstanceView,
    beforeEvidenceId?: string,
  ): Promise<EventTransitionResolution | null>;
}

export function selectEarliestEventTransition(
  resolutions: readonly EventTransitionResolution[],
  beforePosition?: number,
): EventTransitionResolution | null {
  return resolutions.reduce<EventTransitionResolution | null>(
    (earliest, resolution) =>
      beforePosition !== undefined && resolution.position >= beforePosition
        ? earliest
        : earliest === null || resolution.position < earliest.position
          ? resolution
          : earliest,
    null,
  );
}

export function createPrimaryPullRequestEventTransitionResolver(
  journal: EventJournal,
  pullRequests: PullRequestService,
): EventTransitionResolver {
  return new PrimaryPullRequestEventTransitionResolver(journal, pullRequests);
}

class PrimaryPullRequestEventTransitionResolver implements EventTransitionResolver {
  constructor(
    private readonly journal: EventJournal,
    private readonly pullRequests: PullRequestService,
  ) {}

  async resolve(
    workflow: WorkflowInstanceView,
    beforeEvidenceId?: string,
  ): Promise<EventTransitionResolution | null> {
    const transitions = workflow.waitingFor?.eventTransitions;
    if (transitions === undefined) return null;
    const input = await this.pullRequests.authorityInput(workflow.workItemId);
    const primary = input.resources.filter(
      (entry) =>
        entry.resource.primaryCorrelationConflict === undefined &&
        entry.correlations.filter(
          (value) =>
            value.role === ActivityResourceRole.Primary && value.workItemId === workflow.workItemId,
        ).length === 1,
    );
    if (primary.length !== 1) return null;
    const resourceId = primary[0]!.resource.resourceId;
    const pullRequest = input.pullRequests.find((candidate) => candidate.resourceId === resourceId);
    if (pullRequest === undefined) return null;

    const events = await this.journal.readAll(0);
    const beforePosition =
      beforeEvidenceId === undefined
        ? undefined
        : events.find((event) => event.eventId === beforeEvidenceId)?.globalPosition;
    return selectEarliestEventTransition(
      events.flatMap((event) => {
        if (!transitions.some((transition) => transition.event === event.eventType)) return [];
        const activity = selectActivityEvent(event);
        if (activity === null || activity.stream.id !== resourceId) return [];
        const transition = transitions.find((candidate) =>
          matchesPrimaryPullRequestTransition(
            candidate,
            activity,
            pullRequest,
            input.acceptedSignals,
          ),
        );
        return transition === undefined
          ? []
          : [
              {
                evidenceId: event.eventId,
                position: event.globalPosition,
                target: transition.target,
              },
            ];
      }),
      beforePosition,
    );
  }
}

// The closed V1 event union is intentionally matched exhaustively here.
// eslint-disable-next-line complexity
function matchesPrimaryPullRequestTransition(
  transition: CompiledEventTransition,
  event: ActivityEvent,
  pullRequest: {
    readonly resourceId: string;
    readonly state: string;
    readonly checks: string;
    readonly headRevision: string;
    readonly acceptedReview?: { readonly revision: string };
  },
  signals: readonly {
    readonly resourceId: string;
    readonly revision: string;
    readonly trusted: boolean;
  }[],
): boolean {
  if (transition.event !== event.eventType) return false;
  if (event.eventType === ActivityEventType.PrReviewAccepted)
    return (
      event.payload.revision === pullRequest.headRevision &&
      pullRequest.acceptedReview?.revision === pullRequest.headRevision &&
      signals.some(
        (signal) =>
          signal.resourceId === pullRequest.resourceId &&
          signal.revision === pullRequest.headRevision &&
          signal.trusted,
      )
    );
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
