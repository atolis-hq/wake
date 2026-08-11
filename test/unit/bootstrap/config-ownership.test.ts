import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/bootstrap/config/load-config.js';

describe('target configuration ownership', () => {
  it('lets each module parse and default only its own subtree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-config-'));
    await writeFile(
      join(root, 'config.yaml'),
      [
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
    );

    const config = await loadConfig(root);

    expect(config.execution.defaultRunnerPool).toBe('standard');
    expect(config.controlPlane.maxDispatches).toBe(1);
    expect(config.controlPlane.schedules).toEqual([]);
    expect(config.integrations).toEqual({});
    expect(config.surfaces.api.enabled).toBe(false);
  });

  it('reports validation errors with domain-qualified paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-config-'));
    await writeFile(
      join(root, 'config.yaml'),
      'schemaVersion: 1\nwork: {}\nresources: {}\nexecution: {}\norchestration: {}\ncontrolPlane: {}\nintegrations: {}\nsurfaces: {}\n',
    );

    await expect(loadConfig(root)).rejects.toThrow('execution');
  });
});
