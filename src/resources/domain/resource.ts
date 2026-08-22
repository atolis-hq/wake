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
  switch (event.eventType) {
    case ResourceEventType.ResourceDiscovered:
      break;
    case ResourceEventType.ResourceRevisionObserved:
      Object.assign(resource, { revision: event.payload.revision });
      break;
    case ResourceEventType.WorkCorrelationEstablished:
      if (event.payload.role === ResourceCorrelationRole.Primary) delete resource.correlationStatus;
      active.set(event.payload.workItemId, {
        resourceId: resource.resourceId,
        workItemId: event.payload.workItemId,
        role: event.payload.role,
        provenance: event.payload.provenance,
        establishedByEventId: event.eventId,
      });
      break;
    case ResourceEventType.WorkCorrelationRetryPending:
      break;
    case ResourceEventType.WorkCorrelationUnresolvable:
      Object.assign(resource, { correlationStatus: 'unresolvable' });
      break;
    case ResourceEventType.ExternalOutcomeObserved:
      Object.assign(resource, { pendingExternalOutcome: event.payload });
      break;
    case ResourceEventType.ExternalOutcomeReopened:
      delete resource.pendingExternalOutcome;
      break;
    case ResourceEventType.ExternalOutcomeConsumed:
      if (
        resource.pendingExternalOutcome?.sourceObservationId === event.payload.sourceObservationId
      )
        delete resource.pendingExternalOutcome;
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

function assertNever(value: never): never {
  throw new Error(`Unhandled Resource event: ${JSON.stringify(value)}`);
}
