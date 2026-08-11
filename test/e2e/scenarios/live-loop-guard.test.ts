import { afterEach, describe, expect, it } from 'vitest';
import { OrchestrationEventType } from '../../../src/orchestration/index.js';
import { ProcessWorld } from '../support/process-world.js';

describe('E2E-LIVE-006', () => {
  let world: ProcessWorld | undefined;

  afterEach(async () => world?.dispose());

  it('stops a re-triggered watch cycle at its shared group budget', async () => {
    world = await ProcessWorld.create('wake-root-loop');
    await world.tick();
    await world.publishEvidence([
      { key: 'loop#1', title: 'Implement with review', watchEvent: 'fake.review-requested' },
      { key: 'loop#1', title: 'Implement with review', watchEvent: 'fake.review-requested' },
    ]);
    await world.runTicksUntilIdle();

    const events = await world.events();
    expect(
      events.filter((event) => event.eventType === OrchestrationEventType.ChildRequested),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === OrchestrationEventType.CausalActivationRejected),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.eventType === OrchestrationEventType.GroupBudgetExhausted),
    ).toHaveLength(1);
  }, 15_000);
});
