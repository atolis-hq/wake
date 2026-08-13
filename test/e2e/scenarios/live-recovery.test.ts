import { afterEach, expect, it } from 'vitest';
import { DeliveryEventType } from '../../../src/integrations/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIVE-008 preserves an accepted delivery across a composed process restart', async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.publishEvidence([{ key: 'restart#1', title: 'Recover after restart' }]);
  await world.tick();
  await world.tick();

  expect(await world.readProjection('work')).toHaveLength(1);
  expect(
    (await world.events()).filter((event) => event.eventType === DeliveryEventType.Confirmed),
  ).toHaveLength(1);
});
