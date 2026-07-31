import type { EventEnvelope, ProjectionDefinition } from '../../kernel/index.js';
import { isResourceStream, resourceId } from '../../resources/index.js';
import type { AcceptedReviewSignalView, PullRequestView } from './contracts.js';

type Projector = (
  previous: PullRequestView,
  event: EventEnvelope,
  payload: Record<string, unknown>,
) => PullRequestView;

const projectors: Readonly<Record<string, Projector>> = {
  'pr.revision-changed': projectRevision,
  'pr.state-changed': projectState,
  'pr.checks-changed': projectChecks,
  'pr.review-accepted': projectAcceptedReview,
  'pr.review-changes-requested': clearAcceptedReview,
};

export const pullRequestProjection: ProjectionDefinition<PullRequestView | null> = {
  name: 'activities-pr',
  select: (event) => (isResourceStream(event.stream) ? { key: event.stream.id } : null),
  initial: () => null,
  project(previous, event) {
    const payload = asRecord(event.payload);
    if (event.eventType === 'pr.discovered') return projectDiscovery(previous, event, payload);
    if (previous === null) return null;
    const projector = projectors[event.eventType];
    return projector === undefined ? previous : projector(previous, event, payload);
  },
};

export const acceptedReviewSignalProjection: ProjectionDefinition<
  readonly AcceptedReviewSignalView[]
> = {
  name: 'activities-pr-accepted-signals',
  select: (event) => (isResourceStream(event.stream) ? { key: event.stream.id } : null),
  initial: () => [],
  project(previous, event) {
    if (event.eventType !== 'review.acceptance-signal-recorded') return previous;
    const payload = asRecord(event.payload);
    if (!isAcceptedSignal(payload)) return previous;
    return previous.some((signal) => signal.acceptedEventId === payload.acceptedEventId)
      ? previous
      : [...previous, { resourceId: resourceId(event.stream.id), ...payload }];
  },
};

export const activityProjectionDefinitions: readonly ProjectionDefinition[] = [
  pullRequestProjection,
  acceptedReviewSignalProjection,
];

function projectDiscovery(
  previous: PullRequestView | null,
  event: EventEnvelope,
  payload: Record<string, unknown>,
): PullRequestView | null {
  if (!isObservation(payload)) return previous;
  return { resourceId: resourceId(event.stream.id), ...payload };
}

function projectRevision(
  previous: PullRequestView,
  _event: EventEnvelope,
  payload: Record<string, unknown>,
): PullRequestView {
  if (!isRevision(payload)) return previous;
  return { ...clearReview(previous), ...payload };
}

function projectState(
  previous: PullRequestView,
  _event: EventEnvelope,
  payload: Record<string, unknown>,
): PullRequestView {
  return isState(payload.state) ? { ...previous, state: payload.state } : previous;
}

function projectChecks(
  previous: PullRequestView,
  _event: EventEnvelope,
  payload: Record<string, unknown>,
): PullRequestView {
  return isChecks(payload.checks) ? { ...previous, checks: payload.checks } : previous;
}

function projectAcceptedReview(
  previous: PullRequestView,
  event: EventEnvelope,
  payload: Record<string, unknown>,
): PullRequestView {
  if (!isReview(payload)) return previous;
  return {
    ...previous,
    acceptedReview: {
      revision: payload.revision,
      actorId: payload.actorId,
      acceptedEventId: event.eventId,
    },
  };
}

function clearAcceptedReview(previous: PullRequestView): PullRequestView {
  return clearReview(previous);
}

function isObservation(
  value: Record<string, unknown>,
): value is Omit<PullRequestView, 'resourceId'> {
  return (
    typeof value.workItemId === 'string' &&
    isState(value.state) &&
    typeof value.headRevision === 'string' &&
    typeof value.baseRevision === 'string' &&
    isChecks(value.checks)
  );
}

function isRevision(
  value: Record<string, unknown>,
): value is Pick<PullRequestView, 'headRevision' | 'baseRevision'> {
  return typeof value.headRevision === 'string' && typeof value.baseRevision === 'string';
}

function isReview(
  value: Record<string, unknown>,
): value is { readonly revision: string; readonly actorId: string } {
  return typeof value.revision === 'string' && typeof value.actorId === 'string';
}

function isAcceptedSignal(
  value: Record<string, unknown>,
): value is Omit<AcceptedReviewSignalView, 'resourceId'> {
  return (
    typeof value.revision === 'string' &&
    typeof value.actorId === 'string' &&
    (value.actorKind === 'human' || value.actorKind === 'bot') &&
    typeof value.acceptedEventId === 'string' &&
    typeof value.trusted === 'boolean'
  );
}

function isState(value: unknown): value is PullRequestView['state'] {
  return value === 'open' || value === 'closed' || value === 'merged';
}

function isChecks(value: unknown): value is PullRequestView['checks'] {
  return value === 'unknown' || value === 'pending' || value === 'passing' || value === 'failing';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function clearReview(view: PullRequestView): PullRequestView {
  const copy = { ...view };
  delete copy.acceptedReview;
  return copy;
}
