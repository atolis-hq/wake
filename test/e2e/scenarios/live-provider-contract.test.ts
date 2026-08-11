import { afterEach, expect, it } from 'vitest';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIVE-011 runs two provider instances through the same neutral intake path', async () => {
  const world = await ProcessWorld.create('wake-root-second-provider');
  worlds.push(world);
  await world.tick();

  const resources = await world.readProjection<{ externalKey: { adapter: string } }>('resources');
  expect(resources).toHaveLength(2);
  expect(new Set(resources.map((entry) => entry.value.externalKey.adapter))).toEqual(
    new Set(['primary', 'secondary']),
  );
  expect(await world.readProjection('work')).toHaveLength(2);
}, 15_000);
