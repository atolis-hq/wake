import { describe, expect, it } from 'vitest';
import { DeliveryService } from '../../../src-next/integrations/delivery/application/delivery-service.js';
import { resourceId } from '../../../src-next/resources/index.js';

describe('E2E-DELIVERY-001', () => {
  it('reconciles provider acceptance after a crash without a second merge', async () => {
    let deliveries = 0;
    const intent = {
      intentEventId: 'intent-1',
      globalPosition: 1,
      kind: 'pr.merge' as const,
      resourceId: resourceId('resource-1'),
      payload: { kind: 'pr.merge' as const, revision: 'a', method: 'merge' as const },
      state: 'ambiguous' as const,
      attempts: 1,
      reconciliationKey: 'provider-1',
    };
    const service = new DeliveryService({
      intents: async () => [intent],
      resource: async () => ({ resourceId: 'resource-1', adapter: 'fake' }),
      adapter: () => ({
        deliver: async () => {
          deliveries += 1;
          return { kind: 'confirmed' as const, externalId: '1' };
        },
        reconcile: async () => ({ kind: 'confirmed' as const, externalId: '1' }),
      }),
      append: async () => undefined,
    });
    await service.deliverNext(new AbortController().signal);
    expect(deliveries).toBe(0);
  });
});
