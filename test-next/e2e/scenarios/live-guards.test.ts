import { afterEach, expect, it } from 'vitest';
import { OrchestrationEventType } from '../../../src-next/orchestration/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIVE-007 caps retries and escalates the composed workflow', async () => {
  const world = await ProcessWorld.create('wake-root-retry');
  worlds.push(world);
  await world.tick();

  expect(
    (await world.events()).filter(
      (event) => event.eventType === OrchestrationEventType.RetryCounted,
    ),
  ).toHaveLength(2);
}, 15_000);
