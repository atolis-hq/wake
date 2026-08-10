import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src-next/main.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

const scenario = { id: 'E2E-OPS-001' } as const;

describe(`${scenario.id}: doctor rebuild`, () => {
  it('repairs a disposable projection without changing canonical journal bytes', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    const eventsRoot = join(world.wakeRoot, '.wake', 'events');
    const eventPath = join(
      eventsRoot,
      (await readdir(eventsRoot)).find((file) => file.endsWith('.jsonl')) ?? 'missing.jsonl',
    );
    const journalBytes = await readFile(eventPath);
    const projectionPath = join(world.wakeRoot, '.wake', 'projections', 'work', 'global.json');
    await writeFile(projectionPath, '{corrupted');
    const output: string[] = [];

    await main(['doctor', '--wake-root', world.wakeRoot], {
      compose: async (wakeRoot) => {
        const { createCompositionRoot, createSurfaceApplications } =
          await import('../../../src-next/bootstrap/index.js');
        return createSurfaceApplications(await createCompositionRoot(wakeRoot)).cli;
      },
      output: { write: (value) => output.push(value) },
      signal: new AbortController().signal,
    });

    expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({
      projections: expect.arrayContaining([expect.stringMatching(/^work:/)]),
    });
    await main(['doctor', '--rebuild-projections', '--wake-root', world.wakeRoot], {
      compose: async (wakeRoot) => {
        const { createCompositionRoot, createSurfaceApplications } =
          await import('../../../src-next/bootstrap/index.js');
        return createSurfaceApplications(await createCompositionRoot(wakeRoot)).cli;
      },
      output: { write() {} },
      signal: new AbortController().signal,
    });
    expect(await world.readProjection('work')).toHaveLength(1);
    expect(await readFile(eventPath)).toEqual(journalBytes);
  }, 60_000);

  it('reports a configured runner-pool availability failure without mutating state', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await writeFile(
      join(world.wakeRoot, 'config.yaml'),
      `schemaVersion: 1
execution:
  agentRunners: { fake: { kind: fake } }
  runnerPools: { standard: [missing] }
  defaultRunnerPool: standard
controlPlane: {}
integrations: {}
surfaces: {}
`,
    );
    const output: string[] = [];
    await main(['doctor', '--wake-root', world.wakeRoot], {
      compose: async (wakeRoot) => {
        const { createCompositionRoot, createSurfaceApplications } =
          await import('../../../src-next/bootstrap/index.js');
        return createSurfaceApplications(await createCompositionRoot(wakeRoot)).cli;
      },
      output: { write: (value) => output.push(value) },
      signal: new AbortController().signal,
    });
    expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({
      failures: expect.arrayContaining([expect.stringMatching(/runner pool/i)]),
    });
  });

  it('reports a missing required target runtime directory', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    await rm(join(world.wakeRoot, '.wake', 'transcripts'), { recursive: true, force: true });
    const output: string[] = [];
    await main(['doctor', '--wake-root', world.wakeRoot], {
      compose: async (wakeRoot) => {
        const { createCompositionRoot, createSurfaceApplications } =
          await import('../../../src-next/bootstrap/index.js');
        return createSurfaceApplications(await createCompositionRoot(wakeRoot)).cli;
      },
      output: { write: (value) => output.push(value) },
      signal: new AbortController().signal,
    });
    expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({
      failures: expect.arrayContaining([expect.stringMatching(/transcripts/)]),
    });
  });
});
