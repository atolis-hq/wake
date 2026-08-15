import { expect, it } from 'vitest';
import { loadFakeScenarios } from '../../../src/bootstrap/index.js';

type TextFileReader = { readFile(path: string): Promise<string> };

const loadFakeScenariosWith = loadFakeScenarios as unknown as (
  wakeRoot: string,
  fileSystem: TextFileReader,
) => ReturnType<typeof loadFakeScenarios>;

it('uses an empty resolver when fake-scenarios.yaml is absent', async () => {
  await expect(loadFakeScenariosWith('/wake', reader({}))).resolves.toMatchObject({
    resolve: expect.any(Function),
  });
  expect(
    (await loadFakeScenariosWith('/wake', reader({}))).resolve({
      runner: 'fake',
      workflow: 'default',
      action: 'refine',
      occurrence: 1,
    }),
  ).toBeUndefined();
});

it('names the optional file when scenario validation fails', async () => {
  await expect(
    loadFakeScenariosWith('/wake', reader({ 'fake-scenarios.yaml': 'schemaVersion: 2\n' })),
  ).rejects.toThrow(/fake-scenarios\.yaml/);
});

function reader(files: Readonly<Record<string, string>>): TextFileReader {
  return {
    async readFile(path) {
      const value = Object.entries(files).find(([suffix]) => path.endsWith(suffix))?.[1];
      if (value !== undefined) return value;
      throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
    },
  };
}
