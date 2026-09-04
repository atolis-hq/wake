import { afterEach, expect, it } from 'vitest';
import { ExecutionEventType } from '../../../src/execution/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIVE-002 recovers a failed fake run through a later workflow stage', async () => {
  const world = await ProcessWorld.create('wake-root-recovery');
  worlds.push(world);
  await world.tick();

  expect(
    (await world.events()).some((event) => event.event.eventType === ExecutionEventType.RunFailed),
  ).toBe(false);
  expect(await world.readProjection('work')).toHaveLength(1);
  expect(await world.readProjection('orchestration')).toHaveLength(1);
});
