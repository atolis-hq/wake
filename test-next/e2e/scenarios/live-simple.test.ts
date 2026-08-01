import { afterEach, expect, it } from 'vitest';
import { DeliveryEventType } from '../../../src-next/integrations/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('takes fake provider evidence through the composed on-disk process', async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.tick();

  expect(await world.readProjection('work')).toHaveLength(1);
  expect(await world.readProjection('resources')).toHaveLength(1);
  expect(await world.readProjection('orchestration')).toHaveLength(1);
  expect(
    (await world.events()).filter((event) => event.eventType === DeliveryEventType.Confirmed),
  ).toHaveLength(1);
});
