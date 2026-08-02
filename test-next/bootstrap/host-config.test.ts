import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../src-next/bootstrap/config/root-schema.js';

const baseConfig = {
  schemaVersion: 1,
  execution: {
    agentRunners: { fake: { kind: 'fake' } },
    runnerPools: { standard: ['fake'] },
    defaultRunnerPool: 'standard',
  },
  controlPlane: {},
  integrations: {},
  surfaces: {},
};

describe('target host configuration', () => {
  it('defaults the sandbox host deployment settings', () => {
    expect(parseRootConfig(baseConfig).host).toEqual({
      sandbox: {
        image: 'wake-sandbox',
        imageRepository: 'wake-sandbox',
        containerName: 'wake-sandbox',
        wakeMountPath: '/wake',
        containerHomeMountPath: '/home/wake',
        start: { enabled: true },
        extraMounts: [],
      },
      development: {},
    });
  });

  it('requires a source repository only for source-mode host development', () => {
    expect(() =>
      parseRootConfig({ ...baseConfig, host: { development: { mode: 'source' } } }),
    ).toThrow(/repoRoot/);
    expect(
      parseRootConfig({
        ...baseConfig,
        host: { development: { mode: 'source', repoRoot: '/src/wake' } },
      }).host.development,
    ).toEqual({ mode: 'source', repoRoot: '/src/wake' });
  });

  it('requires non-empty configured mount paths', () => {
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        host: { sandbox: { extraMounts: [{ source: '', target: '/repos' }] } },
      }),
    ).toThrow();
  });
});
