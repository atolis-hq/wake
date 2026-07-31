import { describe, expect, it } from 'vitest';
import { createEventDraft, type EventEnvelope } from '../../src-next/kernel/index.js';
import { resourceId, resourceStream } from '../../src-next/resources/index.js';
import { projectDeliveries } from '../../src-next/integrations/delivery/application/delivery-projector.js';
const event = (
  eventType: string,
  eventId: string,
  globalPosition: number,
  payload: Record<string, unknown>,
): EventEnvelope => ({
  ...createEventDraft({
    eventId,
    eventType,
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'c',
    causationId: 'c',
    actor: { kind: 'system', id: 'test' },
    source: { kind: 'internal', id: 'test' },
    stream: resourceStream(resourceId('resource-1')),
    payload,
  }),
  recordedAt: '2026-01-01T00:00:00.000Z',
  sequence: globalPosition,
  globalPosition,
});
describe('delivery projector', () => {
  it('projects unresolved intent positions without copying payload authority', () => {
    const views = projectDeliveries([
      event('pr.merge-requested', 'intent-2', 2, {
        resourceId: 'resource-1',
        revision: 'b',
        method: 'merge',
      }),
      event('pr.approve-requested', 'intent-1', 1, {
        resourceId: 'resource-1',
        revision: 'a',
        body: 'ok',
      }),
    ]);
    expect(views.map((view) => [view.intentEventId, view.globalPosition])).toEqual([
      ['intent-1', 1],
      ['intent-2', 2],
    ]);
  });
});
