import { afterEach, expect, it } from 'vitest';
import { DeliveryIntentEventType } from '../../../src/integrations/index.js';
import { BuiltInResourceCapability, type ResourceView } from '../../../src/resources/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIVE-010 publishes to a commentable non-PR issue Resource', async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.tick();

  const [resource] = await world.readProjection<ResourceView>('resources');
  expect(resource?.value.capabilities).toEqual([BuiltInResourceCapability.Commentable]);
  expect(resource?.value.capabilities).not.toContain(BuiltInResourceCapability.Revisioned);
  expect(
    (await world.events()).filter(
      (event) => event.eventType === DeliveryIntentEventType.StatusPublishRequested,
    ),
  ).toHaveLength(1);
});
