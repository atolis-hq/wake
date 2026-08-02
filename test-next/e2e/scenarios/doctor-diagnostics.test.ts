import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src-next/main.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

async function runDoctor(wakeRoot: string): Promise<{
  readonly failures: readonly string[];
  readonly notices: readonly string[];
}> {
  const output: string[] = [];
  await main(['doctor', '--wake-root', wakeRoot], {
    compose: async (root) => {
      const { createCompositionRoot, createSurfaceApplications } =
        await import('../../../src-next/bootstrap/index.js');
      return createSurfaceApplications(await createCompositionRoot(root)).cli;
    },
    output: { write: (value) => output.push(value) },
    signal: new AbortController().signal,
  });
  return JSON.parse(output.at(-1) ?? '{}') as {
    readonly failures: readonly string[];
    readonly notices: readonly string[];
  };
}

describe('E2E-OPS-002: doctor diagnostics — prompt templates and provider connectivity', () => {
  it('fails when a configured workflow stage references a prompt template that cannot be loaded', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    await writeFile(
      join(world.wakeRoot, 'config.workflows.yaml'),
      `default:
  stages:
    implement:
      activity: agent
      with: { template: implement }
      execution: { workspace: none, runnerPool: standard }
      on:
        done: { then: done }
`,
    );

    const report = await runDoctor(world.wakeRoot);

    expect(report.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/prompt template "implement"/)]),
    );
  });

  it('does not fail on a referenced prompt template once it exists and validates', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    await writeFile(
      join(world.wakeRoot, 'config.workflows.yaml'),
      `default:
  stages:
    implement:
      activity: agent
      with: { template: implement }
      execution: { workspace: none, runnerPool: standard }
      on:
        done: { then: done }
`,
    );
    await mkdir(join(world.wakeRoot, 'prompts'), { recursive: true });
    await writeFile(
      join(world.wakeRoot, 'prompts', 'implement.md'),
      '---\nmaxTurns: 1\n---\nImplement {{objective}}\n',
    );

    const report = await runDoctor(world.wakeRoot);

    expect(report.failures).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/prompt template/)]),
    );
  });

  it('fails when a configured provider is not reachable', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    await writeFile(
      join(world.wakeRoot, 'config.yaml'),
      `schemaVersion: 1
execution:
  agentRunners:
    fake: { kind: fake, timeoutMs: 5000 }
  runnerPools: { standard: [fake] }
  defaultRunnerPool: standard
controlPlane: {}
integrations:
  fake:
    provider: fake
    enabled: true
    evidenceFile: provider/evidence.json
    effectsFile: provider/effects.json
    connectivityError: simulated network outage
surfaces:
  api: { enabled: false }
  web: { enabled: false }
`,
    );

    const report = await runDoctor(world.wakeRoot);

    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/provider "fake" is not reachable: simulated network outage/),
      ]),
    );
  });
});

describe('E2E-OPS-002: doctor diagnostics — sandbox absence and configuration drift', () => {
  it('reports Docker/sandbox absence as a notice, never a failure', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    // Name an image/container that cannot exist on any host, so this proves
    // the absence path deterministically instead of depending on whether the
    // machine running the suite happens to have a real wake-sandbox image.
    await writeFile(
      join(world.wakeRoot, 'config.yaml'),
      `${await readFile(join(world.wakeRoot, 'config.yaml'), 'utf8')}host:
  sandbox:
    image: wake-sandbox-doctor-test-fixture-does-not-exist
    containerName: wake-sandbox-doctor-test-fixture-does-not-exist
`,
    );

    const report = await runDoctor(world.wakeRoot);

    expect(report.notices).toEqual(
      expect.arrayContaining([expect.stringMatching(/Docker sandbox image/)]),
    );
    expect(report.failures).toEqual(expect.not.arrayContaining([expect.stringMatching(/Docker/)]));
  });

  it('surfaces on-disk configuration drift even against an already-composed root', async () => {
    const world = await ProcessWorld.create();
    worlds.push(world);
    await world.tick();
    const configPath = join(world.wakeRoot, 'config.yaml');
    const validConfig = await readFile(configPath, 'utf8');
    const { createCompositionRoot, createSurfaceApplications } =
      await import('../../../src-next/bootstrap/index.js');
    const root = await createCompositionRoot(world.wakeRoot);
    await writeFile(configPath, validConfig.replace('schemaVersion: 1', 'schemaVersion: 2'));

    const report = (await createSurfaceApplications(root).cli.operational?.doctor([])) as {
      readonly failures: readonly string[];
    };

    expect(report.failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/configuration validation failed/)]),
    );
  });
});
