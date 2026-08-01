import { ActivityEventType, selectActivityEvent } from '../../../activities/index.js';
import { type EventEnvelope, type ProjectionDefinition } from '../../../kernel/index.js';
import { IntegrationStreamKind } from '../../contracts/streams.js';
import { DeliveryEventType, selectDeliveryEvent } from '../contracts/events.js';
import { DeliveryIntentEventType, selectDeliveryIntentEvent } from '../contracts/intents.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind, DeliveryResultKind, DeliveryState } from '../contracts/vocabulary.js';

export function projectDeliveries(events: readonly EventEnvelope[]): readonly DeliveryIntentView[] {
  const views = new Map<string, DeliveryIntentView>();
  for (const event of [...events].sort(
    (left, right) => left.globalPosition - right.globalPosition,
  )) {
    const key = deliveryProjection.select(event)?.key;
    if (key === undefined) continue;
    const next = deliveryProjection.project(views.get(key) ?? null, event);
    if (next !== null) views.set(key, next);
  }
  return [...views.values()]
    .filter(
      (view) => view.state === DeliveryState.Pending || view.state === DeliveryState.Ambiguous,
    )
    .sort((left, right) => left.globalPosition - right.globalPosition);
}

export const deliveryProjection: ProjectionDefinition<DeliveryIntentView | null> = {
  name: IntegrationStreamKind.Delivery,
  select(event) {
    const intent = intentView(event);
    if (intent !== null) return { key: intent.eventId };
    const delivery = selectDeliveryEvent(event);
    return delivery === null ? null : { key: delivery.stream.id };
  },
  initial: () => null,
  project(previous, event) {
    const projectedIntent = intentView(event);
    if (projectedIntent !== null) return projectedIntent.view;
    return foldDeliveryFact(previous, selectDeliveryEvent(event));
  },
};
export const deliveryProjectionDefinitions: readonly ProjectionDefinition[] = [deliveryProjection];

function intentView(
  event: EventEnvelope,
): { readonly eventId: string; readonly view: DeliveryIntentView } | null {
  const intent = selectActivityEvent(event);
  if (intent?.eventType === ActivityEventType.PrApproveRequested)
    return {
      eventId: intent.eventId,
      view: {
        intentEventId: intent.eventId,
        globalPosition: intent.globalPosition,
        workflowInstanceId: intent.payload.workflowInstanceId,
        activationId: intent.payload.activationId,
        kind: DeliveryIntentKind.PrApprove,
        resourceId: intent.payload.resourceId,
        payload: {
          kind: DeliveryIntentKind.PrApprove,
          revision: intent.payload.revision,
          ...(intent.payload.body === null ? {} : { body: intent.payload.body }),
        },
        state: DeliveryState.Pending,
        attempts: 0,
        occurrenceOrdinal: 0,
      },
    };
  if (intent?.eventType === ActivityEventType.PrMergeRequested)
    return {
      eventId: intent.eventId,
      view: {
        intentEventId: intent.eventId,
        globalPosition: intent.globalPosition,
        workflowInstanceId: intent.payload.workflowInstanceId,
        activationId: intent.payload.activationId,
        kind: DeliveryIntentKind.PrMerge,
        resourceId: intent.payload.resourceId,
        payload: {
          kind: DeliveryIntentKind.PrMerge,
          revision: intent.payload.revision,
          method: intent.payload.method,
        },
        state: DeliveryState.Pending,
        attempts: 0,
        occurrenceOrdinal: 0,
      },
    };
  const integrationIntent = selectDeliveryIntentEvent(event);
  if (integrationIntent === null) return null;
  const kind =
    integrationIntent.eventType === DeliveryIntentEventType.StatusPublishRequested
      ? DeliveryIntentKind.StatusPublish
      : DeliveryIntentKind.ReplyPublish;
  return {
    eventId: integrationIntent.eventId,
    view: {
      intentEventId: integrationIntent.eventId,
      globalPosition: integrationIntent.globalPosition,
      workflowInstanceId: integrationIntent.payload.workflowInstanceId,
      activationId: integrationIntent.payload.activationId,
      kind,
      resourceId: integrationIntent.payload.resourceId,
      payload: { kind, body: integrationIntent.payload.body },
      state: DeliveryState.Pending,
      attempts: 0,
      occurrenceOrdinal: 0,
    },
  };
}

function foldDeliveryFact(
  previous: DeliveryIntentView | null,
  delivery: ReturnType<typeof selectDeliveryEvent>,
): DeliveryIntentView | null {
  if (delivery === null || previous === null) return previous;
  if (
    delivery.payload.intentEventId !== previous.intentEventId ||
    delivery.payload.intentGlobalPosition !== previous.globalPosition
  )
    return previous;
  const current = {
    ...previous,
    occurrenceOrdinal: Math.max(previous.occurrenceOrdinal, delivery.payload.occurrenceOrdinal),
  };
  switch (delivery.eventType) {
    case DeliveryEventType.AttemptStarted:
      return { ...current, attempts: current.attempts + 1 };
    case DeliveryEventType.Confirmed:
      return { ...current, state: DeliveryState.Confirmed };
    case DeliveryEventType.Failed:
      return { ...current, state: DeliveryState.Failed };
    case DeliveryEventType.Ambiguous:
      return {
        ...current,
        state: DeliveryState.Ambiguous,
        reconciliationKey: delivery.payload.reconciliationKey,
      };
    case DeliveryEventType.Reconciled:
      return delivery.payload.result === DeliveryResultKind.Confirmed
        ? { ...current, state: DeliveryState.Confirmed }
        : current;
  }
}
