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
    title: 'the composed CLI accepts source-update vocabulary for a packaged Wake root',
    given: ['a packaged-mode Wake root'],
    when: ['an operator combines a source override with an npm-only version option'],
    then: ['the command parses the override before rejecting the incompatible option combination'],
  },
  async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);

    await expect(
      main(
        [
          'self-update',
          '--source',
          process.cwd(),
          '--version',
          '1.2.3',
          '--wake-root',
          world.wakeRoot,
        ],
        {
          compose: async (wakeRoot) => {
            const { createCompositionRoot, createSurfaceApplications } =
              await import('../../../src/bootstrap/index.js');
            return (await createSurfaceApplications(await createCompositionRoot(wakeRoot))).cli;
          },
          output: { write() {} },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow('wake self-update --version is only valid for npm updates');
  },
);
