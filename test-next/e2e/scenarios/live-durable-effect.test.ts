import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessWorld } from '../support/process-world.js';

describe('E2E-LIVE-001', () => {
  let world: ProcessWorld | undefined;

  afterEach(async () => world?.dispose());

  it('persists one provider effect across composed-process restarts', async () => {
    world = await ProcessWorld.create();

    await world.runTicksUntilIdle();
    await world.tick();

    const effects = JSON.parse(
      await readFile(join(world.wakeRoot, 'provider', 'effects.json'), 'utf8'),
    ) as Record<string, string>;
    expect(Object.keys(effects)).toHaveLength(1);
    expect(Object.values(effects)).toEqual(['external-1']);
  });
});
