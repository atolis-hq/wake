import { expect, it } from 'vitest';
import { deliveryStream } from '../../../src-next/integrations/contracts/streams.js';
import { DeliveryOutcomeReactor } from '../../../src-next/integrations/delivery/application/delivery-outcome-reactor.js';
import { DeliveryEventType } from '../../../src-next/integrations/delivery/contracts/events.js';
import { createEventDraft, eventId } from '../../../src-next/kernel/index.js';
import {
  InMemoryCheckpointStore,
  InMemoryEventJournal,
} from '../../../src-next/persistence/index.js';

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

it('resolves an activation that is genuinely waiting on this delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(journal, new InMemoryCheckpointStore(), {
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
  });

  await reactor.runOnce();

  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    activationId: 'primary:work-1:activity:1',
    outcome: { kind: 'done' },
  });
});

it('does not resolve a merely-still-open activation that never asked to wait on delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(journal, new InMemoryCheckpointStore(), {
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
  });

  await reactor.runOnce();

  expect(accepted).toHaveLength(0);
});

it('does not resolve a different activation even if it is waiting on an unrelated delivery', async () => {
  const journal = new InMemoryEventJournal(clock);
  await journal.append(deliveryStream(eventId('intent-1')), 0, [
    confirmedEvent({ intentEventId: 'intent-1' }),
  ]);
  const accepted: unknown[] = [];
  const reactor = new DeliveryOutcomeReactor(journal, new InMemoryCheckpointStore(), {
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
  });

  await reactor.runOnce();

  expect(accepted).toHaveLength(0);
});
