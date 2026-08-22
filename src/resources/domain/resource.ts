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
    (event) => event.eventType === ResourceEventType.ResourceDiscovered,
  );
  if (discovered === undefined) return null;
  const resource = discoveredResource(discovered);
  const active = new Map<WorkItemId, ResourceCorrelationView>();

  for (const event of events) applyResourceEvent(resource, active, event);
  return { view: resource, correlations: [...active.values()], events };
}

function discoveredResource(
  event: Extract<ResourceEvent, { eventType: typeof ResourceEventType.ResourceDiscovered }>,
): ResourceView {
  const revision = event.payload.revision === undefined ? {} : { revision: event.payload.revision };
  const title = event.payload.title === undefined ? {} : { title: event.payload.title };
  return {
    resourceId: event.stream.id,
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
  if (isExternalOutcome(event)) {
    applyExternalOutcome(resource, event);
    return;
  }
  if (isCorrelationRetry(event)) {
    applyCorrelationRetry(resource, event);
    return;
  }
  switch (event.eventType) {
    case ResourceEventType.ResourceDiscovered:
      break;
    case ResourceEventType.ResourceRevisionObserved:
      Object.assign(resource, { revision: event.payload.revision });
      break;
    case ResourceEventType.WorkCorrelationEstablished:
      if (event.payload.role === ResourceCorrelationRole.Primary)
        delete (resource as { correlationStatus?: 'unresolvable' }).correlationStatus;
      active.set(event.payload.workItemId, {
        resourceId: resource.resourceId,
        workItemId: event.payload.workItemId,
        role: event.payload.role,
        provenance: event.payload.provenance,
        establishedByEventId: event.eventId,
      });
      break;
    case ResourceEventType.WorkCorrelationConflicted:
      Object.assign(resource, {
        primaryCorrelationConflict: {
          attemptedWorkItemId: event.payload.workItemId,
          existingWorkItemId: event.payload.existingWorkItemId,
          eventId: event.eventId,
        },
      });
      break;
    case ResourceEventType.WorkCorrelationRetracted:
      active.delete(event.payload.workItemId);
      break;
    case ResourceEventType.IssueCompletionObservationConsumed:
    case ResourceEventType.IssueCompletionObservationSuperseded:
      break;
    default:
      assertNever(event);
  }
}

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
