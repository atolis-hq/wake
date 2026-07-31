import { describe, expect, it } from 'vitest';
import { DeliveryService } from '../../../src-next/integrations/delivery/application/delivery-service.js';
import { resourceId } from '../../../src-next/resources/index.js';

describe('E2E-PR-MERGE-003', () => {
  it('delivers an allowed merge once and records its canonical confirmation', async () => {
    const events: string[] = [];
    let calls = 0;
    const service = new DeliveryService({
      intents: async () => [
        {
          intentEventId: 'intent-merge',
          globalPosition: 1,
          kind: 'pr.merge' as const,
          resourceId: resourceId('resource-1'),
          payload: { kind: 'pr.merge' as const, revision: 'a', method: 'merge' as const },
          state: 'pending' as const,
          attempts: 0,
        },
      ],
      resource: async () => ({ resourceId: 'resource-1', adapter: 'fake' }),
      adapter: () => ({
        deliver: async () => {
          calls += 1;
          return { kind: 'confirmed' as const, externalId: '42' };
        },
        reconcile: async () => ({ kind: 'not-found' as const }),
      }),
      append: async (event) => {
        events.push(event.type);
      },
    });
    await service.deliverNext(new AbortController().signal);
    expect(calls).toBe(1);
    expect(events).toEqual(['delivery.attempt-started', 'delivery.confirmed']);
  });
});
