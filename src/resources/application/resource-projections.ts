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
    if (isExternalOutcome(owned)) return projectExternalOutcome(previous, owned);
    if (isCorrelationRetry(owned)) return projectCorrelationRetry(previous, owned);
    switch (owned.eventType) {
      case ResourceEventType.ResourceDiscovered:
        return {
          resourceId: owned.stream.id,
          kind: owned.payload.kind,
          externalKey: owned.payload.externalKey,
          capabilities: owned.payload.capabilities,
          ...(owned.payload.revision === undefined ? {} : { revision: owned.payload.revision }),
          ...(owned.payload.title === undefined ? {} : { title: owned.payload.title }),
        };
      case ResourceEventType.ResourceRevisionObserved:
        return previous === null ? previous : { ...previous, revision: owned.payload.revision };
      case ResourceEventType.WorkCorrelationConflicted:
        return previous === null
          ? previous
          : {
              ...previous,
              primaryCorrelationConflict: {
                attemptedWorkItemId: owned.payload.workItemId,
                existingWorkItemId: owned.payload.existingWorkItemId,
                eventId: owned.eventId,
              },
            };
      case ResourceEventType.WorkCorrelationEstablished:
        return previous === null
          ? previous
          : owned.payload.role === ResourceCorrelationRole.Primary
            ? withoutCorrelationStatus(previous)
            : previous;
      case ResourceEventType.WorkCorrelationRetracted:
      case ResourceEventType.IssueCompletionObservationConsumed:
      case ResourceEventType.IssueCompletionObservationSuperseded:
        return previous;
      default:
        return assertNever(owned);
    }
  },
};

type CorrelationRetryEvent = Extract<
  ResourceEvent,
  {
    eventType:
      | typeof ResourceEventType.WorkCorrelationRetryPending
      | typeof ResourceEventType.WorkCorrelationUnresolvable;
  }
>;

type ExternalOutcomeEvent = Extract<
  ResourceEvent,
  {
    eventType:
      | typeof ResourceEventType.ExternalOutcomeObserved
      | typeof ResourceEventType.ExternalOutcomeReopened
      | typeof ResourceEventType.ExternalOutcomeConsumed;
  }
>;

function isCorrelationRetry(event: ResourceEvent): event is CorrelationRetryEvent {
  return (
    event.eventType === ResourceEventType.WorkCorrelationRetryPending ||
    event.eventType === ResourceEventType.WorkCorrelationUnresolvable
  );
}

function isExternalOutcome(event: ResourceEvent): event is ExternalOutcomeEvent {
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
    if (!changesCorrelation(owned)) return previous;
    switch (owned.eventType) {
      case ResourceEventType.WorkCorrelationEstablished: {
        const correlation: ResourceCorrelationView = {
          resourceId: owned.stream.id,
          workItemId: owned.payload.workItemId,
          role: owned.payload.role,
          provenance: owned.payload.provenance,
          establishedByEventId: owned.eventId,
        };
        return previous.some((value) => value.workItemId === correlation.workItemId)
          ? previous
          : [...previous, correlation];
      }
      case ResourceEventType.WorkCorrelationRetracted:
        return previous.filter((value) => value.workItemId !== owned.payload.workItemId);
      default:
        return assertNever(owned);
    }
  },
};

type CorrelationEvent = Extract<
  ResourceEvent,
  {
    eventType:
      | typeof ResourceEventType.WorkCorrelationEstablished
      | typeof ResourceEventType.WorkCorrelationRetracted;
  }
>;

function changesCorrelation(event: ResourceEvent): event is CorrelationEvent {
  return (
    event.eventType === ResourceEventType.WorkCorrelationEstablished ||
    event.eventType === ResourceEventType.WorkCorrelationRetracted
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Resource event: ${JSON.stringify(value)}`);
}
