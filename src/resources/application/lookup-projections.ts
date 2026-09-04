import type { ProjectionDefinition } from '@atolis-hq/eventing';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';

export const externalKeyProjectionKey = (externalKey: ExternalResourceKey): string =>
  `${encodeURIComponent(externalKey.adapter)}:${encodeURIComponent(externalKey.key)}`;

export const resourcesByExternalKeyProjection: ProjectionDefinition<ResourceId | null> = {
  name: 'resources-by-external-key',
  select(event) {
    const owned = selectResourceEvent(event);
    return owned?.event.eventType === ResourceEventType.ResourceDiscovered
      ? { key: externalKeyProjectionKey(owned.event.payload.externalKey) }
      : null;
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned?.event.eventType !== ResourceEventType.ResourceDiscovered) return previous;
    return previous ?? owned.stream.id;
  },
};

export const workCorrelationsProjection: ProjectionDefinition<readonly ResourceCorrelationView[]> =
  {
    name: 'work-correlations',
    select(event) {
      const owned = selectResourceEvent(event);
      if (owned?.event.eventType === ResourceEventType.WorkCorrelationEstablished)
        return { key: owned.event.payload.workItemId };
      if (owned?.event.eventType === ResourceEventType.WorkCorrelationRetracted)
        return { key: owned.event.payload.workItemId };
      if (owned?.event.eventType === ResourceEventType.WorkCorrelationConflicted)
        return { key: owned.event.payload.workItemId };
      return null;
    },
    initial: () => [],
    project(previous, event) {
      const owned = selectResourceEvent(event);
      if (owned?.event.eventType === ResourceEventType.WorkCorrelationEstablished) {
        const correlation: ResourceCorrelationView = {
          resourceId: owned.stream.id,
          workItemId: owned.event.payload.workItemId,
          role: owned.event.payload.role,
          provenance: owned.event.payload.provenance,
          establishedByEventId: owned.event.eventId,
        };
        return previous.some((value) => value.resourceId === correlation.resourceId)
          ? previous
          : [...previous, correlation];
      }
      if (owned?.event.eventType === ResourceEventType.WorkCorrelationRetracted)
        return previous.filter((value) => value.resourceId !== owned.stream.id);
      return previous;
    },
  };
