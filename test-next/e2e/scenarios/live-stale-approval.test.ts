import { afterEach, describe, expect, it } from 'vitest';
import { ActivityEventType } from '../../../src-next/activities/index.js';
import { ProcessWorld } from '../support/process-world.js';

describe('E2E-LIVE-004', () => {
  let world: ProcessWorld | undefined;

  afterEach(async () => world?.dispose());

  it('denies merge when a newer provider revision invalidates the accepted review', async () => {
    world = await ProcessWorld.create('wake-root-pr-stale');

    await world.runTicksUntilIdle();

    expect(
      (await world.events()).filter((event) => event.eventType === ActivityEventType.PrMergeDenied),
    ).toHaveLength(1);
    expect(
      (await world.events()).filter(
        (event) => event.eventType === ActivityEventType.PrMergeRequested,
      ),
    ).toHaveLength(0);
  }, 15_000);
});
