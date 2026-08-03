import type { ProjectionDefinition } from '../../kernel/index.js';
import { ResourceEventType, selectResourceEvent } from '../contracts/events.js';
import type { ResourceId } from '../contracts/identifiers.js';
import type { ExternalResourceKey, ResourceCorrelationView } from '../contracts/views.js';

export const externalKeyProjectionKey = (externalKey: ExternalResourceKey): string =>
  `${encodeURIComponent(externalKey.adapter)}:${encodeURIComponent(externalKey.key)}`;

export const resourcesByExternalKeyProjection: ProjectionDefinition<ResourceId | null> = {
  name: 'resources-by-external-key',
  select(event) {
    const owned = selectResourceEvent(event);
    return owned?.eventType === ResourceEventType.ResourceDiscovered
      ? { key: externalKeyProjectionKey(owned.payload.externalKey) }
      : null;
  },
  initial: () => null,
  project(previous, event) {
    const owned = selectResourceEvent(event);
    if (owned?.eventType !== ResourceEventType.ResourceDiscovered) return previous;
    return previous ?? owned.stream.id;
  },
};

export const workCorrelationsProjection: ProjectionDefinition<readonly ResourceCorrelationView[]> =
  {
    name: 'work-correlations',
    select(event) {
      const owned = selectResourceEvent(event);
      if (owned?.eventType === ResourceEventType.WorkCorrelationEstablished)
        return { key: owned.payload.workItemId };
      if (owned?.eventType === ResourceEventType.WorkCorrelationRetracted)
        return { key: owned.payload.workItemId };
      return null;
    },
    initial: () => [],
    project(previous, event) {
      const owned = selectResourceEvent(event);
      if (owned?.eventType === ResourceEventType.WorkCorrelationEstablished) {
        const correlation: ResourceCorrelationView = {
          resourceId: owned.stream.id,
          workItemId: owned.payload.workItemId,
          role: owned.payload.role,
          provenance: owned.payload.provenance,
          establishedByEventId: owned.eventId,
        };
        return previous.some((value) => value.resourceId === correlation.resourceId)
          ? previous
          : [...previous, correlation];
      }
      if (owned?.eventType === ResourceEventType.WorkCorrelationRetracted)
        return previous.filter((value) => value.resourceId !== owned.stream.id);
      return previous;
    },
  };
