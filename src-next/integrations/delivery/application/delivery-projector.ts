import {
  EventActorKind,
  EventSourceKind,
  type EventEnvelope,
  ProjectionDefinition,
} from '../../../kernel/index.js';
import { resourceId, ResourceStreamKind } from '../../../resources/index.js';
import { ActivityEventType, MergeMethod } from '../../../activities/index.js';
import { DeliveryEventType } from '../contracts/events.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryResultKind, DeliveryState } from '../contracts/vocabulary.js';

export function projectDeliveries(events: readonly EventEnvelope[]): readonly DeliveryIntentView[] {
  const views = new Map<string, DeliveryIntentView>();
  for (const event of [...events].sort((a, b) => a.globalPosition - b.globalPosition)) {
    const intent = intentFrom(event);
    if (intent !== null) {
      views.set(intent.intentEventId, intent);
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const intentEventId = typeof payload.intentEventId === 'string' ? payload.intentEventId : null;
    if (intentEventId === null || !views.has(intentEventId)) continue;
    const previous = views.get(intentEventId)!;
    switch (event.eventType) {
      case DeliveryEventType.AttemptStarted:
        views.set(intentEventId, { ...previous, attempts: previous.attempts + 1 });
        break;
      case DeliveryEventType.Confirmed:
        views.set(intentEventId, { ...previous, state: DeliveryState.Confirmed });
        break;
      case DeliveryEventType.Failed:
        views.set(intentEventId, { ...previous, state: DeliveryState.Failed });
        break;
      case DeliveryEventType.Ambiguous:
        views.set(intentEventId, {
          ...previous,
          state: DeliveryState.Ambiguous,
          reconciliationKey: String(payload.reconciliationKey),
        });
        break;
      case DeliveryEventType.Reconciled:
        views.set(
          intentEventId,
          payload.result === DeliveryResultKind.Confirmed
            ? { ...previous, state: DeliveryState.Confirmed }
            : previous,
        );
        break;
    }
  }
  return [...views.values()]
    .filter(
      (view) => view.state === DeliveryState.Pending || view.state === DeliveryState.Ambiguous,
    )
    .sort((a, b) => a.globalPosition - b.globalPosition);
}

export const deliveryProjection: ProjectionDefinition<DeliveryIntentView | null> = {
  name: 'delivery',
  select(event) {
    const intent = intentFrom(event);
    if (intent !== null) return { key: intent.intentEventId };
    const payload = event.payload as Record<string, unknown>;
    return event.eventType.startsWith('delivery.') && typeof payload.intentEventId === 'string'
      ? { key: payload.intentEventId }
      : null;
  },
  initial: () => null,
  project(previous, event) {
    return projectDeliveries(previous === null ? [event] : [toEvent(previous), event])[0] ?? null;
  },
};

export const deliveryProjectionDefinitions: readonly ProjectionDefinition[] = [deliveryProjection];

function toEvent(view: DeliveryIntentView): EventEnvelope {
  return {
    eventId: view.intentEventId as never,
    eventType:
      view.kind === 'pr.merge'
        ? ActivityEventType.PrMergeRequested
        : ActivityEventType.PrApproveRequested,
    schemaVersion: 1,
    occurredAt: '',
    correlationId: '' as never,
    causationId: '' as never,
    actor: { kind: EventActorKind.System, id: 'delivery' },
    source: { kind: EventSourceKind.Internal, id: 'delivery' },
    stream: { kind: ResourceStreamKind.Resource, id: view.resourceId },
    payload: payloadFor(view),
    recordedAt: '',
    sequence: 0,
    globalPosition: view.globalPosition,
  };
}
function payloadFor(view: DeliveryIntentView) {
  return {
    resourceId: view.resourceId,
    revision: 'revision' in view.payload ? view.payload.revision : '',
    method: view.payload.kind === 'pr.merge' ? view.payload.method : undefined,
    body: 'body' in view.payload ? view.payload.body : undefined,
  };
}
function intentFrom(event: EventEnvelope): DeliveryIntentView | null {
  const payload = event.payload as Record<string, unknown>;
  const mapped = intentKindFrom(event.eventType);
  if (mapped === null || typeof payload.resourceId !== 'string') return null;
  const resourceIdValue = resourceId(payload.resourceId);
  if (
    mapped === 'pr.merge' &&
    typeof payload.revision === 'string' &&
    typeof payload.method === 'string'
  )
    return {
      intentEventId: event.eventId,
      globalPosition: event.globalPosition,
      kind: mapped,
      resourceId: resourceIdValue,
      payload: { kind: mapped, revision: payload.revision, method: payload.method as MergeMethod },
      state: DeliveryState.Pending,
      attempts: 0,
    };
  if (mapped === 'pr.approve' && typeof payload.revision === 'string')
    return {
      intentEventId: event.eventId,
      globalPosition: event.globalPosition,
      kind: mapped,
      resourceId: resourceIdValue,
      payload: {
        kind: mapped,
        revision: payload.revision,
        ...(typeof payload.body === 'string' ? { body: payload.body } : {}),
      },
      state: DeliveryState.Pending,
      attempts: 0,
    };
  if (
    (mapped === 'status.publish' || mapped === 'reply.publish') &&
    typeof payload.body === 'string'
  )
    return {
      intentEventId: event.eventId,
      globalPosition: event.globalPosition,
      kind: mapped,
      resourceId: resourceIdValue,
      payload: { kind: mapped, body: payload.body },
      state: DeliveryState.Pending,
      attempts: 0,
    };
  return null;
}

function intentKindFrom(eventType: string): DeliveryIntentView['kind'] | null {
  if (eventType === ActivityEventType.PrApproveRequested) return 'pr.approve';
  if (eventType === ActivityEventType.PrMergeRequested) return 'pr.merge';
  if (eventType === 'status.publish-requested') return 'status.publish';
  if (eventType === 'reply.publish-requested') return 'reply.publish';
  return null;
}
