import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { main } from '../../../src/main.js';
import { ProcessWorld } from '../support/process-world.js';
import { defineScenario } from '../support/scenario.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

defineScenario(
  {
    id: 'E2E-OPS-SELF-UPDATE-001',
    title: 'the composed CLI refuses a self-update for a packaged Wake root',
    given: ['a packaged-mode Wake root'],
    when: ['an operator invokes self-update through the public CLI'],
    then: ['the command explains that source mode is required and creates no update ledger'],
  },
  async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);

    await expect(
      main(['self-update', '--wake-root', world.wakeRoot], {
        compose: async (wakeRoot) => {
          const { createCompositionRoot, createSurfaceApplications } =
            await import('../../../src/bootstrap/index.js');
          return createSurfaceApplications(await createCompositionRoot(wakeRoot)).cli;
        },
        output: { write() {} },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('wake self-update requires host.development.mode: source');

    await expect(access(join(world.wakeRoot, '.wake', 'update-ledger.json'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  },
);
