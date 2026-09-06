import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../../src/bootstrap/config/root-schema.js';

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
      selfUpdate: {
        drainTimeoutMs: 30_000,
        cancellationTimeoutMs: 30_000,
        npm: { package: '@atolis-hq/wake', distTag: 'latest' },
      },
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

  it('accepts only positive self-update drain and cancellation timeouts', () => {
    expect(
      parseRootConfig({
        ...baseConfig,
        host: { selfUpdate: { drainTimeoutMs: 1, cancellationTimeoutMs: 2 } },
      }).host.selfUpdate,
    ).toEqual({
      drainTimeoutMs: 1,
      cancellationTimeoutMs: 2,
      npm: { package: '@atolis-hq/wake', distTag: 'latest' },
    });
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        host: { selfUpdate: { drainTimeoutMs: 0, cancellationTimeoutMs: 1 } },
      }),
    ).toThrow();
  });
});
