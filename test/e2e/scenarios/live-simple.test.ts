import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DeliveryEventType } from '../../../src/integrations/index.js';
import { ProcessWorld } from '../support/process-world.js';

const worlds: ProcessWorld[] = [];

afterEach(async () => {
  await Promise.all(worlds.splice(0).map((world) => world.dispose()));
});

const scenario = { id: 'E2E-EXEC-001' } as const;

it(`${scenario.id} takes fake provider evidence through the composed on-disk process`, async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await world.tick();

  expect(await world.readProjection('work')).toHaveLength(1);
  expect(await world.readProjection('resources')).toHaveLength(1);
  expect(await world.readProjection('orchestration')).toHaveLength(1);
  expect(
    (await world.events()).filter((event) => event.event.eventType === DeliveryEventType.Confirmed),
  ).toHaveLength(1);
});

const promptScenario = { id: 'E2E-PROMPT-001' } as const;

it(`${promptScenario.id} renders a Wake-root prompt template through the composed on-disk process`, async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await mkdir(join(world.wakeRoot, 'prompts'));
  await writeFile(
    join(world.wakeRoot, 'prompts', 'refine.md'),
    '---\nmodel: fake-model\nallowedTools: [Read]\nmaxTurns: 40\n---\nTemplate for {{workItemId}}',
  );
  await writeFile(
    join(world.wakeRoot, 'config.workflows.yaml'),
    `default:
  stages:
    refine:
      activity: agent
      with: { template: refine }
      execution: { workspace: none, runnerPool: standard }
      on:
        done: { then: publish }
    publish:
      activity: status.publish
      with: { body: Intake completed }
      on:
        done: { then: done }
`,
  );

  await world.tick();

  expect(
    (await world.events()).filter((event) => event.event.eventType === DeliveryEventType.Confirmed),
  ).toHaveLength(1);
});

it('constructs a configured command runner through the composed on-disk process', async () => {
  const world = await ProcessWorld.create();
  worlds.push(world);
  await writeFile(
    join(world.wakeRoot, 'config.yaml'),
    `schemaVersion: 1
execution:
  agentRunners:
    command:
      kind: command
      command: ${JSON.stringify(process.execPath)}
      args: ['-e', "process.stdout.write('DONE')"]
  runnerPools: { standard: [command] }
  defaultRunnerPool: standard
controlPlane: {}
integrations:
  fake:
    provider: fake
    enabled: true
    evidenceFile: provider/evidence.json
    effectsFile: provider/effects.json
surfaces:
  api: { enabled: false }
  web: { enabled: false }
`,
  );

  await world.tick();

  expect(
    (await world.events()).filter((event) => event.event.eventType === DeliveryEventType.Confirmed),
  ).toHaveLength(1);
});
