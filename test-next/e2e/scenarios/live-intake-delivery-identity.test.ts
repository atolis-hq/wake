import { afterEach, expect, it } from 'vitest';
import {
  DeliveryEventType,
  DeliveryIntentEventType,
} from '../../../src-next/integrations/index.js';
import type { ResourceView } from '../../../src-next/resources/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIVE-009 delivers against the Resource identity intake minted in this run', async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.tick();

  const [resource] = await world.readProjection<ResourceView>('resources');
  expect(resource).toBeDefined();
  const events = await world.events();
  const [intent] = events.filter(
    (event) => event.eventType === DeliveryIntentEventType.StatusPublishRequested,
  );
  expect(intent?.stream.id).toBe(resource?.value.resourceId);
  expect(events.filter((event) => event.eventType === DeliveryEventType.Confirmed)).toHaveLength(1);
});
