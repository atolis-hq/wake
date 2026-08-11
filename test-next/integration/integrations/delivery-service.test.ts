import { describe, expect, it } from 'vitest';
import { resId } from '../../support/identities.js';

import { MergeMethod } from '../../../src-next/activities/index.js';
import { DeliveryService } from '../../../src-next/integrations/delivery/application/delivery-service.js';
import type { DeliveryIntentView } from '../../../src-next/integrations/delivery/contracts/views.js';
import {
  decodeDeliveryEvent,
  DeliveryEventType,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
} from '../../../src-next/integrations/index.js';
import { eventId } from '../../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../../src-next/persistence/index.js';
import {} from '../../../src-next/resources/index.js';
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
    expect(decodeDeliveryEvent(events[1]!).eventType).toBe(DeliveryEventType.Confirmed);
    expect(decodeDeliveryEvent(events[1]!).payload).toMatchObject({
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
        const eventTypes = (await journal.readAll(0)).map((event) => event.eventType);
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
            ? { kind: DeliveryResultKind.Failed as const, code: 'denied', message: 'first failed' }
            : { kind: DeliveryResultKind.Confirmed as const, externalId: 'second-confirmed' };
        },
        reconcile: async () => ({ kind: DeliveryResultKind.NotFound as const }),
      }),
      now: () => '2026-07-31T12:00:00.000Z',
    });

    await service.deliverNext(new AbortController().signal);
    await service.deliverNext(new AbortController().signal);

    expect(calls).toEqual(['first', 'second']);
    expect((await journal.readAll(0)).map((event) => event.eventType)).toEqual([
      DeliveryEventType.AttemptStarted,
      DeliveryEventType.Failed,
      DeliveryEventType.AttemptStarted,
      DeliveryEventType.Confirmed,
    ]);
  });
});
