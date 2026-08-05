import type { ProjectionDefinition } from '../../kernel/index.js';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceCorrelationView, ResourceView } from '../contracts/views.js';

export const resourceProjection: ProjectionDefinition<ResourceView | null> = {
  name: 'resources',
  select(event) {
    const owned = selectResourceEvent(event);
    return owned === null ? null : { key: owned.stream.id };
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned === null) return previous;
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
      case ResourceEventType.WorkCorrelationRetracted:
        return previous;
      default:
        return assertNever(owned);
    }
  },
};

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
      case ResourceEventType.ResourceDiscovered:
      case ResourceEventType.ResourceRevisionObserved:
      case ResourceEventType.WorkCorrelationConflicted:
        return previous;
      default:
        return assertNever(owned);
    }
  },
};

function assertNever(value: never): never {
  throw new Error(`Unhandled Resource event: ${JSON.stringify(value)}`);
}
