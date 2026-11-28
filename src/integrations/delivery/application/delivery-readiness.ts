import { EventActorKind, EventSourceKind } from '@atolis-hq/eventing';
import { IntegrationStreamKind } from '../../contracts/streams.js';
import type { DeliveryResult } from '../contracts/config.js';
import type { DeliveryEventDataInput } from '../contracts/event-factory.js';
import { DeliveryEventType } from '../contracts/events.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import type { DeliveryResultKind } from '../contracts/vocabulary.js';

const readinessRecheckMs = 60_000;
const readinessTimeoutMs = 60 * 60_000;

export function readinessResult(
  intent: DeliveryIntentView,
  result: Extract<DeliveryResult, { readonly kind: typeof DeliveryResultKind.Deferred }>,
  ordinal: number,
  now: string,
): DeliveryEventDataInput {
  const startedAt = intent.readinessWait?.startedAt ?? now;
  const deadline = Date.parse(startedAt) + readinessTimeoutMs;
  const expired = Date.parse(now) >= deadline;
  const eventType = expired ? DeliveryEventType.Failed : DeliveryEventType.Deferred;
  const metadata = {
    eventId: `${intent.intentEventId}:${eventType}:${ordinal}`,
    occurredAt: now,
    correlationId: intent.intentEventId,
    causationId: intent.intentEventId,
    actor: { kind: EventActorKind.System, id: IntegrationStreamKind.Delivery },
    source: { kind: EventSourceKind.Internal, id: IntegrationStreamKind.Delivery },
  };
  const payload = {
    intentEventId: intent.intentEventId,
    intentGlobalPosition: intent.globalPosition,
    workflowInstanceId: intent.workflowInstanceId,
    activationId: intent.activationId,
    occurrenceOrdinal: ordinal,
    code: result.code,
    message: result.message,
  };
  return expired
    ? { ...metadata, eventType: DeliveryEventType.Failed, payload }
    : {
        ...metadata,
        eventType: DeliveryEventType.Deferred,
        payload: {
          ...payload,
          startedAt,
          notBefore: new Date(
            Math.min(Date.parse(now) + readinessRecheckMs, deadline),
          ).toISOString(),
        },
      };
}
