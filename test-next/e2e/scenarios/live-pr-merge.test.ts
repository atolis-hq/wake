import { afterEach, describe, expect, it } from 'vitest';
import { ActivityEventType } from '../../../src-next/activities/index.js';
import { ProcessWorld } from '../support/process-world.js';

const scenario = { id: 'E2E-LIVE-003' } as const;

describe(scenario.id, () => {
  let world: ProcessWorld | undefined;

  afterEach(async () => world?.dispose());

  it('merges a reviewed pull request through the composed fake-provider runtime', async () => {
    world = await ProcessWorld.create('wake-root-pr');

    await world.runTicksUntilIdle();

    expect(
      (await world.events()).filter(
        (event) => event.eventType === ActivityEventType.PrMergeRequested,
      ),
    ).toHaveLength(1);
    expect(
      (await world.events()).filter((event) => event.eventType === ActivityEventType.PrMergeDenied),
    ).toHaveLength(0);
  });
});
