import { type EventEnvelope, type ProjectionDefinition } from '@atolis-hq/eventing';
import { ActivityEventType, selectActivityEvent } from '../../../activities/index.js';
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
      (view) =>
        (view.state === DeliveryState.Pending || view.state === DeliveryState.Ambiguous) &&
        view.escalation === undefined,
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

type IntentViewResult = { readonly eventId: string; readonly view: DeliveryIntentView } | null;

function intentView(event: EventEnvelope): IntentViewResult {
  const activityIntent = activityIntentView(event);
  if (activityIntent !== null) return activityIntent;
  const integrationIntent = selectDeliveryIntentEvent(event);
  return integrationIntent === null ? null : integrationIntentView(integrationIntent);
}

function activityIntentView(event: EventEnvelope): IntentViewResult {
  const intent = selectActivityEvent(event);
  if (intent?.event.eventType === ActivityEventType.IssueCompleteRequested)
    return {
      eventId: intent.event.eventId,
      view: {
        intentEventId: intent.event.eventId,
        globalPosition: intent.globalPosition,
        workflowInstanceId: intent.event.payload.workflowInstanceId,
        activationId: intent.event.payload.activationId,
        kind: DeliveryIntentKind.IssueComplete,
        resourceId: intent.event.payload.resourceId,
        payload: { kind: DeliveryIntentKind.IssueComplete },
        state: DeliveryState.Pending,
        attempts: 0,
        occurrenceOrdinal: 0,
        reconciliationAttempts: 0,
      },
    };
  if (intent?.event.eventType === ActivityEventType.PrApproveRequested)
    return {
      eventId: intent.event.eventId,
      view: {
        intentEventId: intent.event.eventId,
        globalPosition: intent.globalPosition,
        workflowInstanceId: intent.event.payload.workflowInstanceId,
        activationId: intent.event.payload.activationId,
        kind: DeliveryIntentKind.PrApprove,
        resourceId: intent.event.payload.resourceId,
        payload: {
          kind: DeliveryIntentKind.PrApprove,
          revision: intent.event.payload.revision,
          ...(intent.event.payload.body === null ? {} : { body: intent.event.payload.body }),
        },
        state: DeliveryState.Pending,
        attempts: 0,
        occurrenceOrdinal: 0,
        reconciliationAttempts: 0,
      },
    };
  if (intent?.event.eventType === ActivityEventType.PrMergeRequested)
    return {
      eventId: intent.event.eventId,
      view: {
        intentEventId: intent.event.eventId,
        globalPosition: intent.globalPosition,
        workflowInstanceId: intent.event.payload.workflowInstanceId,
        activationId: intent.event.payload.activationId,
        kind: DeliveryIntentKind.PrMerge,
        resourceId: intent.event.payload.resourceId,
        payload: {
          kind: DeliveryIntentKind.PrMerge,
          revision: intent.event.payload.revision,
          method: intent.event.payload.method,
          autoMerge: intent.event.payload.autoMerge,
        },
        state: DeliveryState.Pending,
        attempts: 0,
        occurrenceOrdinal: 0,
        reconciliationAttempts: 0,
      },
    };
  return null;
}

function integrationIntentView(
  integrationIntent: NonNullable<ReturnType<typeof selectDeliveryIntentEvent>>,
): IntentViewResult {
  if (integrationIntent.event.eventType === DeliveryIntentEventType.AgentRunPublishRequested)
    return {
      eventId: integrationIntent.event.eventId,
      view: {
        intentEventId: integrationIntent.event.eventId,
        globalPosition: integrationIntent.globalPosition,
        workflowInstanceId: integrationIntent.event.payload.workflowInstanceId,
        activationId: integrationIntent.event.payload.activationId,
        kind: DeliveryIntentKind.AgentRunPublish,
        resourceId: integrationIntent.event.payload.resourceId,
        payload: {
          kind: DeliveryIntentKind.AgentRunPublish,
          report: integrationIntent.event.payload.report,
          conversationId: integrationIntent.event.payload.conversationId,
          conversationEntryId: integrationIntent.event.payload.conversationEntryId,
        },
        state: DeliveryState.Pending,
        attempts: 0,
        occurrenceOrdinal: 0,
      },
    };
  const status =
    integrationIntent.event.eventType === DeliveryIntentEventType.StatusPublishRequested;
  return {
    eventId: integrationIntent.event.eventId,
    view: {
      intentEventId: integrationIntent.event.eventId,
      globalPosition: integrationIntent.globalPosition,
      workflowInstanceId: integrationIntent.event.payload.workflowInstanceId,
      activationId: integrationIntent.event.payload.activationId,
      kind: status ? DeliveryIntentKind.StatusPublish : DeliveryIntentKind.ReplyPublish,
      resourceId: integrationIntent.event.payload.resourceId,
      payload: status
        ? { kind: DeliveryIntentKind.StatusPublish, body: integrationIntent.event.payload.body }
        : { kind: DeliveryIntentKind.ReplyPublish, body: integrationIntent.event.payload.body },
      state: DeliveryState.Pending,
      attempts: 0,
      occurrenceOrdinal: 0,
    },
  };
}

// eslint-disable-next-line complexity
function foldDeliveryFact(
  previous: DeliveryIntentView | null,
  delivery: ReturnType<typeof selectDeliveryEvent>,
): DeliveryIntentView | null {
  if (delivery === null || previous === null) return previous;
  if (
    delivery.event.payload.intentEventId !== previous.intentEventId ||
    delivery.event.payload.intentGlobalPosition !== previous.globalPosition
  )
    return previous;
  const current = {
    ...previous,
    occurrenceOrdinal: Math.max(
      previous.occurrenceOrdinal,
      delivery.event.payload.occurrenceOrdinal,
    ),
  };
  switch (delivery.event.eventType) {
    case DeliveryEventType.AttemptStarted:
      return { ...current, attempts: current.attempts + 1 };
    case DeliveryEventType.Confirmed:
      return { ...current, state: DeliveryState.Confirmed, resolvedAt: delivery.event.occurredAt };
    case DeliveryEventType.Failed:
      return { ...current, state: DeliveryState.Failed, resolvedAt: delivery.event.occurredAt };
    case DeliveryEventType.Ambiguous:
      return {
        ...current,
        state: DeliveryState.Ambiguous,
        resolvedAt: delivery.event.occurredAt,
        reconciliationKey: delivery.event.payload.reconciliationKey,
      };
    case DeliveryEventType.Escalated:
      return { ...current, escalation: { reason: delivery.event.payload.reason } };
    case DeliveryEventType.Reconciled:
      if (delivery.event.payload.result === DeliveryResultKind.Confirmed)
        return {
          ...current,
          state: DeliveryState.Confirmed,
          resolvedAt: delivery.event.occurredAt,
          escalation: undefined,
        };
      return delivery.event.payload.result === DeliveryResultKind.Unknown
        ? { ...current, reconciliationAttempts: (current.reconciliationAttempts ?? 0) + 1 }
        : current;
  }
}
