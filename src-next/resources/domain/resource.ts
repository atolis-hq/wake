import type { EventEnvelope } from '../../kernel/index.js';
import { workItemId, type WorkItemId } from '../../work/index.js';
import { resourceId } from '../contracts/identifiers.js';
import type { ResourceCorrelationView, ResourceView } from '../contracts/views.js';

export interface FoldedResource {
  readonly view: ResourceView;
  readonly correlations: readonly ResourceCorrelationView[];
}

export function foldResource(events: readonly EventEnvelope[]): FoldedResource | null {
  const discovered = events.find((event) => event.eventType === 'resources.resource-discovered');
  if (discovered === undefined) return null;
  const resource = discoveredResource(discovered);
  const active = new Map<WorkItemId, ResourceCorrelationView>();

  for (const event of events) applyResourceEvent(resource, active, event);
  return { view: resource, correlations: [...active.values()] };
}

function discoveredResource(event: EventEnvelope): ResourceView {
  if (
    !isRecord(event.payload) ||
    typeof event.payload.kind !== 'string' ||
    !isExternalKey(event.payload.externalKey) ||
    !Array.isArray(event.payload.capabilities)
  ) {
    throw new Error('Invalid resource discovery event');
  }
  const revision =
    typeof event.payload.revision === 'string' ? { revision: event.payload.revision } : {};
  return {
    resourceId: resourceId(event.stream.id),
    kind: event.payload.kind,
    externalKey: event.payload.externalKey,
    capabilities: event.payload.capabilities as ResourceView['capabilities'],
    ...revision,
  };
}

function applyResourceEvent(
  resource: ResourceView,
  active: Map<WorkItemId, ResourceCorrelationView>,
  event: EventEnvelope,
): void {
  if (
    event.eventType === 'resources.resource-revision-observed' &&
    isRecord(event.payload) &&
    typeof event.payload.revision === 'string'
  ) {
    Object.assign(resource, { revision: event.payload.revision });
  }
  if (event.eventType === 'resources.work-correlation-established')
    establish(active, resource.resourceId, event);
  if (event.eventType === 'resources.work-correlation-conflicted')
    recordPrimaryConflict(resource, event);
  if (
    event.eventType === 'resources.work-correlation-retracted' &&
    isRecord(event.payload) &&
    typeof event.payload.workItemId === 'string'
  ) {
    active.delete(workItemId(event.payload.workItemId));
  }
}

function recordPrimaryConflict(resource: ResourceView, event: EventEnvelope): void {
  if (
    !isRecord(event.payload) ||
    typeof event.payload.workItemId !== 'string' ||
    typeof event.payload.existingWorkItemId !== 'string'
  )
    return;
  Object.assign(resource, {
    primaryCorrelationConflict: {
      attemptedWorkItemId: workItemId(event.payload.workItemId),
      existingWorkItemId: workItemId(event.payload.existingWorkItemId),
      eventId: event.eventId,
    },
  });
}

function establish(
  active: Map<WorkItemId, ResourceCorrelationView>,
  resource: ResourceView['resourceId'],
  event: EventEnvelope,
): void {
  if (
    !isRecord(event.payload) ||
    typeof event.payload.workItemId !== 'string' ||
    !isRole(event.payload.role)
  ) {
    throw new Error('Invalid resource correlation event');
  }
  const work = workItemId(event.payload.workItemId);
  active.set(work, {
    resourceId: resource,
    workItemId: work,
    role: event.payload.role,
    establishedByEventId: event.eventId,
  });
}

function isExternalKey(value: unknown): value is ResourceView['externalKey'] {
  return isRecord(value) && typeof value.adapter === 'string' && typeof value.key === 'string';
}

function isRole(value: unknown): value is ResourceCorrelationView['role'] {
  return value === 'primary' || value === 'secondary';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
