import type { ProjectionDefinition } from '../../kernel/index.js';
import { workItemId } from '../../work/index.js';
import { resourceId } from '../contracts/identifiers.js';
import type { ResourceCorrelationView, ResourceView } from '../contracts/views.js';
export const resourceProjection: ProjectionDefinition<ResourceView | null> = {
  name: 'resources',
  select: (event) => (event.stream.kind === 'resource' ? { key: event.stream.id } : null),
  initial: () => null,
  project(previous, event) {
    const payload = record(event.payload) ? event.payload : {};
    if (event.eventType === 'resources.resource-discovered')
      return {
        resourceId: resourceId(event.stream.id),
        kind: String(payload.kind),
        externalKey: payload.externalKey as ResourceView['externalKey'],
        capabilities: payload.capabilities as ResourceView['capabilities'],
        ...(typeof payload.revision === 'string' ? { revision: payload.revision } : {}),
      };
    if (
      previous !== null &&
      event.eventType === 'resources.resource-revision-observed' &&
      typeof payload.revision === 'string'
    )
      return { ...previous, revision: payload.revision };
    return previous;
  },
};
export const resourceCorrelationProjection: ProjectionDefinition<
  readonly ResourceCorrelationView[]
> = {
  name: 'resource-correlations',
  select: (event) => (event.stream.kind === 'resource' ? { key: event.stream.id } : null),
  initial: () => [],
  project(previous, event) {
    const payload = record(event.payload) ? event.payload : {};
    if (event.eventType === 'resources.work-correlation-established') {
      const correlation: ResourceCorrelationView = {
        resourceId: resourceId(event.stream.id),
        workItemId: workItemId(String(payload.workItemId)),
        role: payload.role as ResourceCorrelationView['role'],
        establishedByEventId: event.eventId,
      };
      return previous.some((value) => value.workItemId === correlation.workItemId)
        ? previous
        : [...previous, correlation];
    }
    if (event.eventType === 'resources.work-correlation-retracted')
      return previous.filter((value) => value.workItemId !== payload.workItemId);
    return previous;
  },
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
