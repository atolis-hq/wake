import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadFakeScenarios } from '../../../src-next/bootstrap/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('uses an empty resolver when fake-scenarios.yaml is absent', async () => {
  const root = await temporaryRoot();

  await expect(loadFakeScenarios(root)).resolves.toMatchObject({
    resolve: expect.any(Function),
  });
  expect(
    (await loadFakeScenarios(root)).resolve({
      runner: 'fake',
      workflow: 'default',
      action: 'refine',
      occurrence: 1,
    }),
  ).toBeUndefined();
});

it('names the optional file when scenario validation fails', async () => {
  const root = await temporaryRoot();
  await writeFile(join(root, 'fake-scenarios.yaml'), 'schemaVersion: 2\n');

  await expect(loadFakeScenarios(root)).rejects.toThrow(/fake-scenarios\.yaml/);
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-fake-scenarios-'));
  roots.push(root);
  return root;
}
