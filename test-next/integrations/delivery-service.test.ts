import { describe, expect, it } from 'vitest';
import { resId } from '../support/identities.js';

import { MergeMethod } from '../../src-next/activities/index.js';
import { DeliveryService } from '../../src-next/integrations/delivery/application/delivery-service.js';
import {
  decodeDeliveryEvent,
  DeliveryEventType,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
} from '../../src-next/integrations/index.js';
import { eventId } from '../../src-next/kernel/index.js';
import { InMemoryEventJournal } from '../../src-next/persistence/index.js';
import {} from '../../src-next/resources/index.js';
import { FakeClock } from '../e2e/support/world.js';

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
});
