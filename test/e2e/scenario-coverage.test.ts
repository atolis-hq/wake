import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it('runs the scenario coverage gate against the catalogue and target scenario suite', async () => {
  const result = await execFileAsync('node', ['scripts/check-scenario-coverage.mjs'], {
    cwd: process.cwd(),
  });

  expect(result.stdout).toMatch(/^Scenario coverage valid: \d+ catalogue scenario IDs\n$/);
  expect(result.stderr).toBe('');
});

it('rejects a descriptor that is not tied to an actual Vitest registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-scenario-coverage-'));
  const catalogue = join(root, 'catalogue.md');
  const scenarioId = ['E2E', 'EXAMPLE', '001'].join('-');
  await writeFile(catalogue, `${scenarioId}\n`);
  await writeFile(
    join(root, 'orphan.test.ts'),
    `const scenario = { id: '${scenarioId}' } as const;\nvoid scenario;\n`,
  );

  await expect(
    execFileAsync('node', ['scripts/check-scenario-coverage.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, SCENARIO_CATALOGUE: catalogue, SCENARIO_TEST_ROOT: root },
    }),
  ).rejects.toMatchObject({ stderr: expect.stringContaining('no registered target test') });
});

it('ignores scenario-shaped prose outside the catalogue target-scenarios cell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wake-scenario-coverage-'));
  const catalogue = join(root, 'catalogue.md');
  const scenarioId = ['E2E', 'EXAMPLE', '001'].join('-');
  await writeFile(
    catalogue,
    [
      '| ID | Target scenarios | Evidence |',
      '| --- | --- | --- |',
      `| EXAMPLE | ${scenarioId} | ` + '`E2E-NOT-A-SCENARIO-001` is explanatory prose. |',
    ].join('\n'),
  );
  await writeFile(
    join(root, 'example.test.ts'),
    `import { defineScenario } from 'support';\ndefineScenario({ id: '${scenarioId}' });\n`,
  );

  const result = await execFileAsync('node', ['scripts/check-scenario-coverage.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, SCENARIO_CATALOGUE: catalogue, SCENARIO_TEST_ROOT: root },
  });

  expect(result.stdout).toContain('1 catalogue scenario IDs');
});
