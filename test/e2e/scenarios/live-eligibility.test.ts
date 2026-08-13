import { afterEach, expect, it } from 'vitest';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

const scenario = { id: 'E2E-LIVE-005' } as const;

it(`${scenario.id} leaves ineligible fake evidence outside Wake domain state`, async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.publishEvidence([{ key: 'ignored#1', title: 'Ignore this', eligible: false }]);
  await world.tick();

  expect(await world.readProjection('work')).toHaveLength(0);
  expect(await world.readProjection('resources')).toHaveLength(0);
  expect(await world.readProjection('orchestration')).toHaveLength(0);
});
