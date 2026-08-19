import { expect, it } from 'vitest';
import { deliveryStream } from '../../../src/integrations/contracts/streams.js';
import { DeliveryOutcomeReactor } from '../../../src/integrations/delivery/application/delivery-outcome-reactor.js';
import { DeliveryEventType } from '../../../src/integrations/delivery/contracts/events.js';
import { createEventDraft, eventId } from '../../../src/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
  InMemoryProjectionStore,
} from '../../../src/persistence/index.js';

const clock = { now: () => new Date('2026-08-09T00:00:00.000Z') };

function confirmedEvent(overrides: {
  readonly intentEventId?: string;
  readonly workflowInstanceId?: string;
  readonly activationId?: string;
}) {
  const intentEventId = overrides.intentEventId ?? 'intent-1';
  const stream = deliveryStream(eventId(intentEventId));
  return createEventDraft({
    eventId: `${intentEventId}:confirmed`,
    eventType: DeliveryEventType.Confirmed,
    occurredAt: clock.now().toISOString(),
    correlationId: 'delivery-outcome-test',
    causationId: 'delivery-outcome-test',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream,
    payload: {
      intentEventId,
      intentGlobalPosition: 1,
      workflowInstanceId: overrides.workflowInstanceId ?? 'primary:work-1',
      activationId: overrides.activationId ?? 'primary:work-1:activity:1',
      occurrenceOrdinal: 1,
      externalId: 'external-1',
    },
  }) as never;
}

function failedEvent() {
  return createEventDraft({
    eventId: 'intent-1:failed',
    eventType: DeliveryEventType.Failed,
    occurredAt: clock.now().toISOString(),
    correlationId: 'delivery-outcome-test',
    causationId: 'delivery-outcome-test',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: deliveryStream(eventId('intent-1')),
    payload: {
      intentEventId: 'intent-1',
      intentGlobalPosition: 1,
      workflowInstanceId: 'primary:work-1',
      activationId: 'primary:work-1:activity:1',
      occurrenceOrdinal: 1,
      code: 'denied',
      message: 'Delivery was denied',
    },
  }) as never;
}

function reconciledConfirmedEvent() {
  return createEventDraft({
    eventId: 'intent-1:reconciled',
    eventType: DeliveryEventType.Reconciled,
    occurredAt: clock.now().toISOString(),
    correlationId: 'delivery-outcome-test',
    causationId: 'delivery-outcome-test',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: deliveryStream(eventId('intent-1')),
    payload: {
      intentEventId: 'intent-1',
      intentGlobalPosition: 1,
      workflowInstanceId: 'primary:work-1',
      activationId: 'primary:work-1:activity:1',
      occurrenceOrdinal: 1,
      result: 'confirmed',
      externalId: 'external-1',
    },
  }) as never;
}

it('resolves an activation that is genuinely waiting on this delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('catches up a matching confirmation that was checkpointed before its delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  let isWaiting = false;
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        return isWaiting
          ? ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
              waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
            } as never)
          : ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
            } as never);
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();
  isWaiting = true;
  await reactor.runOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('catches up a confirmation when its delivery wait appears during the same reactor pass', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  let reads = 0;
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        reads += 1;
        return reads === 1
          ? ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
            } as never)
          : ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
              waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
            } as never);
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();

  expect(accepted).toHaveLength(1);
});

it('catches up a matching failure that was checkpointed before its delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [failedEvent()]);
  const accepted: unknown[] = [];
  let isWaiting = false;
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        return isWaiting
          ? ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
              waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
            } as never)
          : ({
              pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
            } as never);
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();
  isWaiting = true;
  await reactor.runOnce();

  expect(accepted).toMatchObject([{ outcome: { kind: 'failed', data: { reason: 'denied' } } }]);
});

it('resolves a confirmed reconciliation for its matching delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [reconciledConfirmedEvent()]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-1' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();

  expect(accepted).toMatchObject([{ outcome: { kind: 'done' } }]);
});

it('does not resolve a merely-still-open activation that never asked to wait on delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        // A plain agent activation left pending for an unrelated reason (e.g.
        // its own outcome had no configured route) — never declared it was
        // waiting on this or any delivery.
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'active' },
          waitingFor: undefined,
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();

  expect(accepted).toHaveLength(0);
});

it('does not resolve a different activation even if it is waiting on an unrelated delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
    new InMemoryCheckpointStore(),
    {
      async get() {
        return {
          pendingActivation: { activationId: 'primary:work-1:activity:1', status: 'waiting' },
          // Waiting, but on a different intent than the one that just confirmed.
          waitingFor: { signalKind: 'delivery-result', intentEventId: 'intent-other' },
        } as never;
      },
      async acceptOutcome(command) {
        accepted.push(command);
        return {} as never;
      },
    },
    new InMemoryProjectionStore(),
  );

  await reactor.runOnce();

  expect(accepted).toHaveLength(0);
});
