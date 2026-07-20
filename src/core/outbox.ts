import { randomUUID } from 'node:crypto';

import type { OutboundSink } from './contracts.js';
import type { createProjectionUpdater } from './projection-updater.js';
import type { Clock } from '../lib/clock.js';
import type { EventEnvelope } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
type ProjectionUpdater = ReturnType<typeof createProjectionUpdater>;

const outboxMaxAttempts = 3;

const outboundIntentEventTypes = new Set([
  'wake.publish.intent.requested',
  'wake.labels.requested',
]);
const outboundConfirmationEventTypes = new Set([
  'ticket.reply.published',
  'ticket.labels.updated',
  'wake.publish.confirmed',
  'pr.comment.reply.published',
  'pr.review-comment.reply.published',
]);

// The outbox: outbound delivery (comments, labels) attempted independently of
// run-outcome recording, with a durable, bounded retry trace. Extracted from
// tick-runner.ts so it can be exercised in isolation; it has the cleanest
// boundary of the tick's collaborators — no dependency on candidate selection.
export function createOutbox(deps: {
  clock: Clock;
  stateStore: StateStore;
  outboundSink?: OutboundSink;
  projectionUpdater: ProjectionUpdater;
}) {
  async function recordDeliveryFailure(intentEvent: EventEnvelope, err: unknown): Promise<void> {
    const occurredAt = deps.clock.now().toISOString();
    const failureEvent = createEventEnvelope({
      eventId: `${intentEvent.eventId}-delivery-failed-${randomUUID()}`,
      workItemKey: intentEvent.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.failed',
      sourceRefs: intentEvent.sourceRefs,
      occurredAt,
      ingestedAt: occurredAt,
      trigger: 'context-only',
      payload: {
        intentEventId: intentEvent.eventId,
        intentEventType: intentEvent.sourceEventType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    await deps.stateStore.appendEventEnvelope(failureEvent);
    await deps.projectionUpdater.rebuildFromEvents([failureEvent]);
  }

  // Outbound delivery (comments, labels) is attempted independently of run-outcome
  // recording: a delivery failure must never rewrite an already-recorded run result
  // (S1), and must always leave a durable, retryable trace instead of being lost
  // (E5). This never throws — failures become a `wake.publish.failed` event.
  async function attemptDelivery(event: EventEnvelope): Promise<void> {
    if (deps.outboundSink === undefined) {
      return;
    }

    try {
      const deliveryEvents = await deps.outboundSink.deliverIntent({ event });
      for (const deliveryEvent of deliveryEvents) {
        await deps.stateStore.appendEventEnvelope(deliveryEvent);
      }
      await deps.projectionUpdater.rebuildFromEvents(deliveryEvents);

      if (deliveryEvents.length === 0) {
        // No confirmation event was produced (e.g. a no-op label update) but the
        // sink did not throw. Record that delivery was attempted successfully so
        // the outbox scan below does not retry it indefinitely.
        const confirmedAt = deps.clock.now().toISOString();
        const confirmedEvent = createEventEnvelope({
          eventId: `${event.eventId}-confirmed`,
          workItemKey: event.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.publish.confirmed',
          sourceRefs: event.sourceRefs,
          occurredAt: confirmedAt,
          ingestedAt: confirmedAt,
          trigger: 'context-only',
          payload: { intentEventId: event.eventId },
        });
        await deps.stateStore.appendEventEnvelope(confirmedEvent);
      }
    } catch (err) {
      await recordDeliveryFailure(event, err);
    }
  }

  async function deliverOutboundEvent(event: EventEnvelope): Promise<void> {
    await deps.stateStore.appendEventEnvelope(event);
    await deps.projectionUpdater.rebuildFromEvents([event]);
    await attemptDelivery(event);
  }

  // Adopts the outbox pattern: an intent is only considered delivered once a
  // matching confirmation event exists. Anything left unconfirmed by a prior tick
  // (e.g. the process crashed mid-delivery) is retried here, bounded so a
  // permanently failing sink dead-letters instead of retrying forever.
  async function retryUnconfirmedDeliveries(): Promise<void> {
    if (deps.outboundSink === undefined) {
      return;
    }

    const events = await deps.stateStore.listEventEnvelopes();
    const confirmedIntentIds = new Set<string>();
    const failureAttempts = new Map<string, number>();

    for (const event of events) {
      const intentEventId = event.payload.intentEventId;
      if (typeof intentEventId !== 'string') {
        continue;
      }
      if (outboundConfirmationEventTypes.has(event.sourceEventType)) {
        confirmedIntentIds.add(intentEventId);
      }
      if (event.sourceEventType === 'wake.publish.failed') {
        failureAttempts.set(intentEventId, (failureAttempts.get(intentEventId) ?? 0) + 1);
      }
    }

    for (const intent of events) {
      if (!outboundIntentEventTypes.has(intent.sourceEventType)) {
        continue;
      }
      if (confirmedIntentIds.has(intent.eventId)) {
        continue;
      }
      if ((failureAttempts.get(intent.eventId) ?? 0) >= outboxMaxAttempts) {
        continue;
      }
      await attemptDelivery(intent);
    }
  }

  return { attemptDelivery, deliverOutboundEvent, retryUnconfirmedDeliveries };
}
