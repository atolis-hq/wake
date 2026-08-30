import { describe, expect, it } from 'vitest';
import { resId } from '../../support/identities.js';

import { MergeMethod } from '../../../src/activities/index.js';
import { DeliveryService } from '../../../src/integrations/delivery/application/delivery-service.js';
import type { DeliveryIntentView } from '../../../src/integrations/delivery/contracts/views.js';
import {
  decodeDeliveryEvent,
  DeliveryEventType,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
} from '../../../src/integrations/index.js';
import { eventId } from '../../../src/kernel/index.js';
import { InMemoryEventJournal } from '../../../src/persistence/index.js';
import {} from '../../../src/resources/index.js';
import { FakeClock } from '../../e2e/support/world.js';

describe('DeliveryService', () => {
  it('uses the canonical intent event id as the provider idempotency key', async () => {
    const calls: string[] = [];
    const intentEventId = eventId('intent-1');
    const journal = new InMemoryEventJournal(new FakeClock());
    const service = new DeliveryService({
      journal,
      intents: async () => [
        {
          intentEventId,
          globalPosition: 1,
          workflowInstanceId: 'workflow-1',
          activationId: 'activation-1',
          kind: DeliveryIntentKind.PrMerge,
          resourceId: resId('1'),
          payload: {
            kind: DeliveryIntentKind.PrMerge,
            revision: 'abc',
            method: MergeMethod.Merge,
          },
          state: DeliveryState.Pending,
          attempts: 0,
          occurrenceOrdinal: 0,
        },
      ],
      resource: async () => ({ resourceId: 'resource-1', adapter: 'github' }),
      adapter: () => ({
        deliver: async (intent: { readonly intentEventId: string }) => {
          calls.push(intent.intentEventId);
          return { kind: DeliveryResultKind.Confirmed, externalId: '42' };
        },
        reconcile: async () => ({ kind: DeliveryResultKind.NotFound }),
      }),
      now: () => '2026-07-31T12:00:00.000Z',
    });

    await service.deliverNext(new AbortController().signal);

    expect(calls).toEqual(['intent-1']);
    const events = await journal.readAll(0);
    expect(decodeDeliveryEvent(events[1]!).event.eventType).toBe(DeliveryEventType.Confirmed);
    expect(decodeDeliveryEvent(events[1]!).event.payload).toMatchObject({
      intentEventId: 'intent-1',
      intentGlobalPosition: 1,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      occurrenceOrdinal: 1,
    });
  });

  it('delivers pending intents in projection order and isolates a failed provider from the next resource', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const calls: string[] = [];
    const first: DeliveryIntentView = {
      intentEventId: eventId('intent-first'),
      globalPosition: 1,
      workflowInstanceId: 'workflow-first',
      activationId: 'activation-first',
      kind: DeliveryIntentKind.StatusPublish,
      resourceId: resId('first'),
      payload: { kind: DeliveryIntentKind.StatusPublish, body: 'first' },
      state: DeliveryState.Pending,
      attempts: 0,
      occurrenceOrdinal: 0,
    };
    const second: DeliveryIntentView = {
      ...first,
      intentEventId: eventId('intent-second'),
      globalPosition: 2,
      workflowInstanceId: 'workflow-second',
      activationId: 'activation-second',
      resourceId: resId('second'),
      payload: { kind: DeliveryIntentKind.StatusPublish, body: 'second' },
    };
    const service = new DeliveryService({
      journal,
      intents: async () => {
        const eventTypes = (await journal.readAll(0)).map((event) => event.event.eventType);
        return eventTypes.includes(DeliveryEventType.Failed) ? [second] : [first, second];
      },
      resource: async (id) => ({
        resourceId: id,
        adapter: id === first.resourceId ? 'first' : 'second',
      }),
      adapter: (name) => ({
        deliver: async () => {
          calls.push(name);
          return name === 'first'
            ? { kind: DeliveryResultKind.Failed, code: 'denied', message: 'first failed' }
            : { kind: DeliveryResultKind.Confirmed, externalId: 'second-confirmed' };
        },
        reconcile: async () => ({ kind: DeliveryResultKind.NotFound }),
      }),
      now: () => '2026-07-31T12:00:00.000Z',
    });

    await service.deliverNext(new AbortController().signal);
    await service.deliverNext(new AbortController().signal);

    expect(calls).toEqual(['first', 'second']);
    expect((await journal.readAll(0)).map((event) => event.event.eventType)).toEqual([
      DeliveryEventType.AttemptStarted,
      DeliveryEventType.Failed,
      DeliveryEventType.AttemptStarted,
      DeliveryEventType.Confirmed,
    ]);
  });

  it('durably fails an intent whose resource provider is unavailable without recording an attempt', async () => {
    const journal = new InMemoryEventJournal(new FakeClock());
    const intent: DeliveryIntentView = {
      intentEventId: eventId('intent-unavailable-provider'),
      globalPosition: 1,
      workflowInstanceId: 'workflow-1',
      activationId: 'activation-1',
      kind: DeliveryIntentKind.StatusPublish,
      resourceId: resId('resource-1'),
      payload: { kind: DeliveryIntentKind.StatusPublish, body: 'status' },
      state: DeliveryState.Pending,
      attempts: 0,
      occurrenceOrdinal: 0,
    };
    const service = new DeliveryService({
      journal,
      intents: async () => [intent],
      resource: async () => ({ resourceId: intent.resourceId, adapter: 'github' }),
      adapter: () => null,
      now: () => '2026-08-16T20:00:00.000Z',
    });

    await service.deliverNext(new AbortController().signal);

    const events = await journal.readAll(0);
    expect(events).toHaveLength(1);
    expect(decodeDeliveryEvent(events[0]!)).toMatchObject({
      event: {
        eventType: DeliveryEventType.Failed,
        payload: {
          intentEventId: 'intent-unavailable-provider',
          occurrenceOrdinal: 1,
          code: 'provider-unavailable',
          message: 'Delivery provider github is unavailable',
        },
      },
    });
  });
});
