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

describe('transcript capture configuration', () => {
  it('defaults transcript capture to disabled with one-day retention', () => {
    expect(parseRootConfig(baseConfig).transcripts).toEqual({
      enabled: false,
      retentionMs: 86_400_000,
    });
  });

  it('rejects the removed retainAfterWorkspaceCleanup option', () => {
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        transcripts: { retainAfterWorkspaceCleanup: true },
      }),
    ).toThrow(/retainAfterWorkspaceCleanup/);
  });
});

describe('workspace prepare configuration', () => {
  it('defaults the prepare timeout and rejects malformed hook definitions', () => {
    expect(
      parseRootConfig({
        ...baseConfig,
        execution: {
          ...baseConfig.execution,
          workspaceHooks: { prepare: { command: 'prepare.sh' } },
        },
      }).execution.workspaceHooks,
    ).toEqual({ prepare: { command: 'prepare.sh', timeoutMs: 300_000 } });
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        execution: { ...baseConfig.execution, workspaceHooks: { prepare: { command: ' ' } } },
      }),
    ).toThrow(/command/);
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        execution: {
          ...baseConfig.execution,
          workspaceHooks: { prepare: { command: 'prepare.sh', unexpected: true } },
        },
      }),
    ).toThrow(/unexpected/);
  });
});

describe('control-plane concurrency configuration', () => {
  it('defaults to one concurrent Run and requires a positive integer', () => {
    expect(parseRootConfig(baseConfig).controlPlane.maxConcurrentRuns).toBe(1);
    expect(
      parseRootConfig({ ...baseConfig, controlPlane: { maxConcurrentRuns: 2 } }).controlPlane
        .maxConcurrentRuns,
    ).toBe(2);
    expect(() =>
      parseRootConfig({ ...baseConfig, controlPlane: { maxConcurrentRuns: 0 } }),
    ).toThrow(/maxConcurrentRuns/);
  });
});

describe('web surface configuration', () => {
  it('accepts an optional HTTPS public URL for GitHub message links', () => {
    expect(
      parseRootConfig({
        ...baseConfig,
        surfaces: { web: { publicUrl: 'https://wake.example.com' } },
      }).surfaces.web,
    ).toEqual({ enabled: false, publicUrl: 'https://wake.example.com' });
  });

  it('rejects a non-HTTPS public URL', () => {
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        surfaces: { web: { publicUrl: 'http://wake.example.com' } },
      }),
    ).toThrow(/https/i);
  });
});
