import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config/load-config.js';

type TextFileReader = { readFile(path: string): Promise<string> };

const loadConfigWith = loadConfig as unknown as (
  wakeRoot: string,
  fileSystem: TextFileReader,
) => ReturnType<typeof loadConfig>;

describe('target configuration ownership', () => {
  it('lets each module parse and default only its own subtree', async () => {
    const config = await loadConfigWith(
      '/wake',
      reader({
        'config.yaml': [
          'schemaVersion: 1',
          'work: {}',
          'resources: {}',
          'execution:',
          '  agentRunners:',
          '    fake: { kind: fake }',
          '  runnerPools:',
          '    standard: [fake]',
          '  defaultRunnerPool: standard',
          'orchestration: { workflows: {} }',
          'controlPlane: {}',
          'integrations: {}',
          'surfaces: {}',
        ].join('\n'),
      }),
    );

    expect(config.execution.defaultRunnerPool).toBe('standard');
    expect(config.controlPlane.maxDispatches).toBe(1);
    expect(config.controlPlane.maxConcurrentRuns).toBe(1);
    expect(config.controlPlane.schedules).toEqual([]);
    expect(config.integrations).toEqual({});
    expect(config.surfaces.api.enabled).toBe(false);
  });

  it('reports validation errors with domain-qualified paths', async () => {
    await expect(
      loadConfigWith(
        '/wake',
        reader({
          'config.yaml':
            'schemaVersion: 1\nwork: {}\nresources: {}\nexecution: {}\norchestration: {}\ncontrolPlane: {}\nintegrations: {}\nsurfaces: {}\n',
        }),
      ),
    ).rejects.toThrow('execution');
  });
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
