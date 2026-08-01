import { describe, expect, it } from 'vitest';
import { composeDeliveryRuntime } from '../../../src-next/bootstrap/index.js';
import {
  DeliveryEventType,
  DurableFakeDeliveryProvider,
} from '../../../src-next/integrations/index.js';
import { InMemoryProjectionStore } from '../../../src-next/persistence/index.js';
import { TestWorld } from '../support/world.js';
import { executeMerge, setupMergeScenario } from './pr-activity-fixtures.js';

describe('E2E-PR-MERGE-003', () => {
  it('delivers through projections and advances the waiting workflow only after confirmation', async () => {
    const world = new TestWorld();
    const setup = await setupMergeScenario(world, 'safe');
    const workflowId = await executeMerge(world, setup.workItemId);
    const provider = new DurableFakeDeliveryProvider();
    const runtime = composeDeliveryRuntime({
      journal: world.journal,
      projections: new InMemoryProjectionStore(),
      checkpoints: world.checkpoints,
      resource: async (id) => ({ resourceId: id, adapter: 'fake' }),
      adapter: () => provider,
      now: () => world.clock.now().toISOString(),
      orchestration: world.orchestration,
    });

    await runtime.runOnce(new AbortController().signal);

    expect(provider.effects).toHaveLength(1);
    expect((await world.viewWorkflow(workflowId))?.status).toBe('completed');
    expect((await world.events()).map((event) => event.eventType)).toContain(
      DeliveryEventType.Confirmed,
    );
  });
});
