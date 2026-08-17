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

describe('execution session-resume configuration', () => {
  it('defaults and validates the resumable-session token budget', () => {
    expect(parseRootConfig(baseConfig).execution.maxResumableSessionTokens).toBe(200_000);
    expect(
      parseRootConfig({
        ...baseConfig,
        execution: { ...baseConfig.execution, maxResumableSessionTokens: 50_000 },
      }).execution.maxResumableSessionTokens,
    ).toBe(50_000);
    expect(() =>
      parseRootConfig({
        ...baseConfig,
        execution: { ...baseConfig.execution, maxResumableSessionTokens: 0 },
      }),
    ).toThrow(/maxResumableSessionTokens/);
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
