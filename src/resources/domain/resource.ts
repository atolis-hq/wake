import type { WorkItemId } from '../../work/index.js';
import { ResourceEventType, type ResourceEvent } from '../contracts/events.js';
import type { ResourceCorrelationView, ResourceView } from '../contracts/views.js';
import { ResourceCorrelationRole } from '../contracts/vocabulary.js';

export interface FoldedResource {
  readonly view: ResourceView;
  readonly correlations: readonly ResourceCorrelationView[];
  readonly events: readonly ResourceEvent[];
}

export function foldResource(events: readonly ResourceEvent[]): FoldedResource | null {
  const discovered = events.find(
    (event) => event.event.eventType === ResourceEventType.ResourceDiscovered,
  );
  if (discovered === undefined) return null;
  if (discovered.event.eventType !== ResourceEventType.ResourceDiscovered) return null;
  const resource = discoveredResource(discovered.stream.id, discovered.event);
  const active = new Map<WorkItemId, ResourceCorrelationView>();

  for (const event of events) applyResourceEvent(resource, active, event);
  return { view: resource, correlations: [...active.values()], events };
}

function discoveredResource(
  resourceId: ResourceView['resourceId'],
  event: Extract<
    ResourceEvent['event'],
    { eventType: typeof ResourceEventType.ResourceDiscovered }
  >,
): ResourceView {
  const revision = event.payload.revision === undefined ? {} : { revision: event.payload.revision };
  const title = event.payload.title === undefined ? {} : { title: event.payload.title };
  return {
    resourceId,
    kind: event.payload.kind,
    externalKey: event.payload.externalKey,
    capabilities: event.payload.capabilities,
    ...revision,
    ...title,
  };
}

function applyResourceEvent(
  resource: ResourceView,
  active: Map<WorkItemId, ResourceCorrelationView>,
  event: ResourceEvent,
): void {
  const resourceEvent = event.event;
  if (isExternalOutcome(resourceEvent)) {
    applyExternalOutcome(resource, resourceEvent);
    return;
  }
  if (isCorrelationRetry(resourceEvent)) {
    applyCorrelationRetry(resource, resourceEvent);
    return;
  }
  switch (resourceEvent.eventType) {
    case ResourceEventType.ResourceDiscovered:
      break;
    case ResourceEventType.ResourceRevisionObserved:
      Object.assign(resource, { revision: resourceEvent.payload.revision });
      break;
    case ResourceEventType.WorkCorrelationEstablished:
      if (resourceEvent.payload.role === ResourceCorrelationRole.Primary)
        delete (resource as { correlationStatus?: 'unresolvable' }).correlationStatus;
      active.set(resourceEvent.payload.workItemId, {
        resourceId: resource.resourceId,
        workItemId: resourceEvent.payload.workItemId,
        role: resourceEvent.payload.role,
        provenance: resourceEvent.payload.provenance,
        establishedByEventId: resourceEvent.eventId,
      });
      break;
    case ResourceEventType.WorkCorrelationConflicted:
      Object.assign(resource, {
        primaryCorrelationConflict: {
          attemptedWorkItemId: resourceEvent.payload.workItemId,
          existingWorkItemId: resourceEvent.payload.existingWorkItemId,
          eventId: resourceEvent.eventId,
        },
      });
      break;
    case ResourceEventType.WorkCorrelationRetracted:
      active.delete(resourceEvent.payload.workItemId);
      break;
    case ResourceEventType.IssueCompletionObservationConsumed:
    case ResourceEventType.IssueCompletionObservationSuperseded:
      break;
    default:
      assertNever(resourceEvent);
  }
}

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

function applyCorrelationRetry(resource: ResourceView, event: CorrelationRetryEvent): void {
  switch (event.eventType) {
    case ResourceEventType.WorkCorrelationRetryPending:
      return;
    case ResourceEventType.WorkCorrelationUnresolvable:
      Object.assign(resource, { correlationStatus: 'unresolvable' });
      return;
    default:
      return assertNever(event);
  }
}

function applyExternalOutcome(resource: ResourceView, event: ExternalOutcomeEvent): void {
  switch (event.eventType) {
    case ResourceEventType.ExternalOutcomeObserved:
      Object.assign(resource, { pendingExternalOutcome: event.payload });
      return;
    case ResourceEventType.ExternalOutcomeReopened:
      delete (resource as { pendingExternalOutcome?: ResourceView['pendingExternalOutcome'] })
        .pendingExternalOutcome;
      return;
    case ResourceEventType.ExternalOutcomeConsumed:
      if (
        resource.pendingExternalOutcome?.sourceObservationId === event.payload.sourceObservationId
      )
        delete (resource as { pendingExternalOutcome?: ResourceView['pendingExternalOutcome'] })
          .pendingExternalOutcome;
      return;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Resource event: ${JSON.stringify(value)}`);
}
