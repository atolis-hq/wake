import { describe, expect, it } from 'vitest';

import { DeliveryService } from '../../src-next/integrations/delivery/application/delivery-service.js';
import { resourceId } from '../../src-next/resources/index.js';

describe('DeliveryService', () => {
  it('uses the canonical intent event id as the provider idempotency key', async () => {
    const calls: string[] = [];
    const service = new DeliveryService({
      intents: async () => [
        {
          intentEventId: 'intent-1',
          globalPosition: 1,
          kind: 'pr.merge',
          resourceId: resourceId('resource-1'),
          payload: { kind: 'pr.merge', revision: 'abc', method: 'merge' },
          state: 'pending',
          attempts: 0,
        },
      ],
      resource: async () => ({ resourceId: 'resource-1', adapter: 'github' }),
      adapter: () => ({
        deliver: async (intent: { readonly intentEventId: string }) => {
          calls.push(intent.intentEventId);
          return { kind: 'confirmed' as const, externalId: '42' };
        },
        reconcile: async () => ({ kind: 'not-found' as const }),
      }),
      append: async () => undefined,
    });

    await service.deliverNext(new AbortController().signal);

    expect(calls).toEqual(['intent-1']);
  });
});
