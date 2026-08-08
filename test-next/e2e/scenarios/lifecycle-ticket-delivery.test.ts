import { afterEach, expect, it } from 'vitest';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

it('E2E-LIFECYCLE-004 mints a work item from a ticket and delivers a comment per stage', async () => {
  const world = await ProcessWorld.create('wake-root-lifecycle');
  worlds.push(world);

  await world.runTicksUntilIdle();

  const workItems = await world.readProjection<{ readonly state: string }>('work');
  expect(workItems).toHaveLength(1);

  const publishIntents = (await world.events()).filter(
    (event) => event.eventType === 'agent-run.publish-requested',
  );
  expect(publishIntents.length).toBeGreaterThanOrEqual(2);

  const orchestrationViews = await world.readProjection<{
    readonly view: { readonly status: string } | null;
  }>('orchestration');
  expect(orchestrationViews).toHaveLength(1);
  expect(orchestrationViews[0]?.value.view?.status).toBe('completed');
});
