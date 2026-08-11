import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
import { createCompositionRoot } from '../../../src/bootstrap/index.js';
import { writeTranscript } from '../../../src/execution/index.js';
import { ProcessWorld } from '../support/process-world.js';
import { defineScenario } from '../support/scenario.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

defineScenario(
  {
    id: 'E2E-OPS-TRANSCRIPT-001',
    title:
      'the composed execution boundary retains a runner transcript under the private Wake root',
    given: ['a configured Wake root'],
    when: ['execution records an operator-visible runner response'],
    then: ['the response remains readable from the composition-owned transcript directory'],
  },
  async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    const root = await createCompositionRoot(world.wakeRoot);

    const transcript = await writeTranscript(
      root.paths.transcriptsRoot,
      'run/operator-visible',
      'response',
      'completed implementation',
    );

    expect(transcript).toBe(join(root.paths.transcriptsRoot, 'run-operator-visible.response.txt'));
    await expect(readFile(transcript, 'utf8')).resolves.toBe('completed implementation');
  },
);
