import type { ProjectionDefinition } from '../../kernel/index.js';
import { ResourceEventType, selectResourceEvent, type ResourceEvent } from '../contracts/events.js';
import type { ResourceCorrelationView, ResourceView } from '../contracts/views.js';
import { ResourceCorrelationRole } from '../contracts/vocabulary.js';

export const resourceProjection: ProjectionDefinition<ResourceView | null> = {
  name: 'resources',
  select(event) {
    const owned = selectResourceEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => null,
  // eslint-disable-next-line complexity
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned === null) return previous;
    const resourceEvent = owned.event;
    if (isExternalOutcome(resourceEvent)) return projectExternalOutcome(previous, resourceEvent);
    if (isCorrelationRetry(resourceEvent)) return projectCorrelationRetry(previous, resourceEvent);
    switch (resourceEvent.eventType) {
      case ResourceEventType.ResourceDiscovered:
        return {
          resourceId: owned.stream.id,
          kind: resourceEvent.payload.kind,
          externalKey: resourceEvent.payload.externalKey,
          capabilities: resourceEvent.payload.capabilities,
          ...(resourceEvent.payload.revision === undefined
            ? {}
            : { revision: resourceEvent.payload.revision }),
          ...(resourceEvent.payload.title === undefined
            ? {}
            : { title: resourceEvent.payload.title }),
        };
      case ResourceEventType.ResourceRevisionObserved:
        return previous === null
          ? previous
          : { ...previous, revision: resourceEvent.payload.revision };
      case ResourceEventType.WorkCorrelationConflicted:
        return previous === null
          ? previous
          : {
              ...previous,
              primaryCorrelationConflict: {
                attemptedWorkItemId: resourceEvent.payload.workItemId,
                existingWorkItemId: resourceEvent.payload.existingWorkItemId,
                eventId: resourceEvent.eventId,
              },
            };
      case ResourceEventType.WorkCorrelationEstablished:
        return previous === null
          ? previous
          : resourceEvent.payload.role === ResourceCorrelationRole.Primary
            ? withoutCorrelationStatus(previous)
            : previous;
      case ResourceEventType.WorkCorrelationRetracted:
      case ResourceEventType.IssueCompletionObservationConsumed:
      case ResourceEventType.IssueCompletionObservationSuperseded:
        return previous;
      default:
        return assertNever(resourceEvent);
    }
  },
};

type CorrelationRetryEvent = Extract<
  ResourceEvent['event'],
  {
    eventType:
      | typeof ResourceEventType.WorkCorrelationRetryPending
      | typeof ResourceEventType.WorkCorrelationUnresolvable;
  }
>;

type ExternalOutcomeEvent = Extract<
  ResourceEvent['event'],
  {
    eventType:
      | typeof ResourceEventType.ExternalOutcomeObserved
      | typeof ResourceEventType.ExternalOutcomeReopened
      | typeof ResourceEventType.ExternalOutcomeConsumed;
  }
>;

function isCorrelationRetry(event: ResourceEvent['event']): event is CorrelationRetryEvent {
  return (
    event.eventType === ResourceEventType.WorkCorrelationRetryPending ||
    event.eventType === ResourceEventType.WorkCorrelationUnresolvable
  );
}

function isExternalOutcome(event: ResourceEvent['event']): event is ExternalOutcomeEvent {
  return (
    event.eventType === ResourceEventType.ExternalOutcomeObserved ||
    event.eventType === ResourceEventType.ExternalOutcomeReopened ||
    event.eventType === ResourceEventType.ExternalOutcomeConsumed
  );
}

function projectCorrelationRetry(
  previous: ResourceView | null,
  event: CorrelationRetryEvent,
): ResourceView | null {
  switch (event.eventType) {
    case ResourceEventType.WorkCorrelationRetryPending:
      return previous;
    case ResourceEventType.WorkCorrelationUnresolvable:
      return previous === null ? previous : { ...previous, correlationStatus: 'unresolvable' };
    default:
      return assertNever(event);
  }
}

function projectExternalOutcome(
  previous: ResourceView | null,
  event: ExternalOutcomeEvent,
): ResourceView | null {
  switch (event.eventType) {
    case ResourceEventType.ExternalOutcomeObserved:
      return previous === null ? previous : { ...previous, pendingExternalOutcome: event.payload };
    case ResourceEventType.ExternalOutcomeReopened:
      return previous === null ? previous : withoutPendingExternalOutcome(previous);
    case ResourceEventType.ExternalOutcomeConsumed:
      return previous?.pendingExternalOutcome?.sourceObservationId ===
        event.payload.sourceObservationId
        ? withoutPendingExternalOutcome(previous)
        : previous;
    default:
      return assertNever(event);
  }
}

function withoutCorrelationStatus(view: ResourceView): ResourceView {
  const { correlationStatus: _correlationStatus, ...withoutStatus } = view;
  return withoutStatus;
}

function withoutPendingExternalOutcome(view: ResourceView): ResourceView {
  const { pendingExternalOutcome: _pendingExternalOutcome, ...withoutOutcome } = view;
  return withoutOutcome;
}

export const resourceCorrelationProjection: ProjectionDefinition<
  readonly ResourceCorrelationView[]
> = {
  name: 'resource-correlations',
  select(event) {
    const owned = selectResourceEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => [],
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned === null) return previous;
    const resourceEvent = owned.event;
    if (!changesCorrelation(resourceEvent)) return previous;
    switch (resourceEvent.eventType) {
      case ResourceEventType.WorkCorrelationEstablished: {
        const correlation: ResourceCorrelationView = {
          resourceId: owned.stream.id,
          workItemId: resourceEvent.payload.workItemId,
          role: resourceEvent.payload.role,
          provenance: resourceEvent.payload.provenance,
          establishedByEventId: resourceEvent.eventId,
        };
        return previous.some((value) => value.workItemId === correlation.workItemId)
          ? previous
          : [...previous, correlation];
      }
      case ResourceEventType.WorkCorrelationRetracted:
        return previous.filter((value) => value.workItemId !== resourceEvent.payload.workItemId);
      default:
        return assertNever(resourceEvent);
    }
  },
};

type CorrelationEvent = Extract<
  ResourceEvent['event'],
  {
    eventType:
      | typeof ResourceEventType.WorkCorrelationEstablished
      | typeof ResourceEventType.WorkCorrelationRetracted;
  }
>;

function changesCorrelation(event: ResourceEvent['event']): event is CorrelationEvent {
  return (
    event.eventType === ResourceEventType.WorkCorrelationEstablished ||
    event.eventType === ResourceEventType.WorkCorrelationRetracted
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Resource event: ${JSON.stringify(value)}`);
}
