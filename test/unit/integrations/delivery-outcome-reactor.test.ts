import { expect, it } from 'vitest';
import { deliveryStream } from '../../../src/integrations/contracts/streams.js';
import { DeliveryOutcomeReactor } from '../../../src/integrations/delivery/application/delivery-outcome-reactor.js';
import { DeliveryEventType } from '../../../src/integrations/delivery/contracts/events.js';
import { createEventData, eventId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal, InMemoryProjectionStore } from '../../../src/persistence/index.js';

const clock = { now: () => new Date('2026-08-09T00:00:00.000Z') };

it('exposes its stable event processor identity', () => {
  const reactor = new DeliveryOutcomeReactor({} as never, {} as never, {} as never);

  expect(reactor).toMatchObject({
    processor: {
      consumer: 'reactor:delivery-outcomes',
      name: 'delivery-outcomes',
      owner: 'integrations',
    },
  });
});

it('skips facts outside the delivery namespace', () => {
  const reactor = new DeliveryOutcomeReactor({} as never, {} as never, {} as never);

  expect(
    (reactor.processor as never as { select: (event: unknown) => unknown }).select({
      eventType: 'work.created',
    }),
  ).toBeNull();
});

function confirmedEvent(overrides: {
  readonly intentEventId?: string;
  readonly workflowInstanceId?: string;
  readonly activationId?: string;
}) {
  const intentEventId = overrides.intentEventId ?? 'intent-1';
  const stream = deliveryStream(eventId(intentEventId));
  return createEventData({
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
  return createEventData({
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
  return createEventData({
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
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);
  await reactor.reconcileOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('catches up a matching confirmation that was checkpointed before its delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  let isWaiting = false;
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);
  isWaiting = true;
  await reactor.reconcileOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('catches up a confirmation when its delivery wait appears during reconciliation', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  let reads = 0;
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);
  await reactor.reconcileOnce();

  expect(accepted).toHaveLength(1);
});

it('catches up a matching failure that was checkpointed before its delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [failedEvent()]);
  const accepted: unknown[] = [];
  let isWaiting = false;
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);
  isWaiting = true;
  await reactor.reconcileOnce();

  expect(accepted).toMatchObject([{ outcome: { kind: 'failed', data: { reason: 'denied' } } }]);
});

it('resolves a confirmed reconciliation for its matching delivery wait', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    reconciledConfirmedEvent(),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);

  expect(accepted).toMatchObject([{ outcome: { kind: 'done' } }]);
});

it('does not resolve a merely-still-open activation that never asked to wait on delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);

  expect(accepted).toHaveLength(0);
});

it('does not resolve a different activation even if it is waiting on an unrelated delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
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

  await reactor.react((await journal.readAll(0))[0]!);

  expect(accepted).toHaveLength(0);
});

it('continues delivery reconciliation when recording conversation provenance fails', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.appendToStream(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(
    journal,
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
    {
      list: async () => [
        {
          value: {
            intentEventId: 'intent-1',
            resourceId: 'resource-1',
            payload: {
              kind: 'agent-run.publish',
              conversationId: 'conversation-00000000000000000000000001',
              conversationEntryId: 'agent-run-1',
            },
          },
        },
      ],
      read: async () => null,
      write: async () => undefined,
    } as never,
    { recordRepresentation: async () => Promise.reject(new Error('conversation unavailable')) },
  );

  await expect(reactor.react((await journal.readAll(0))[0]!)).resolves.toBeUndefined();

  expect(accepted).toHaveLength(1);
});
