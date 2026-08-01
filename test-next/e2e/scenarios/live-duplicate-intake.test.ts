import { afterEach, expect, it } from 'vitest';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('keeps duplicate fake-provider evidence correlated to one minted Resource and WorkItem', async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.tick();

  expect(await world.readProjection('resources')).toHaveLength(1);
  expect(await world.readProjection('work')).toHaveLength(1);
  expect(await world.readProjection('orchestration')).toHaveLength(1);
});
