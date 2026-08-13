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
