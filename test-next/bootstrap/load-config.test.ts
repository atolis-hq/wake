import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../src-next/bootstrap/config/root-schema.js';

describe('root configuration', () => {
  it('keeps workflow configuration in the orchestration subtree', () => {
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        runners: { fake: { kind: 'fake' } },
        tiers: { standard: ['fake'] },
        defaultTier: 'standard',
      },
      orchestration: {
        workflows: {
          default: {
            stages: {
              implement: {
                activity: 'implement',
                with: { prompt: 'implement' },
                on: { done: { then: 'done' } },
              },
              done: {
                activity: 'implement',
                with: { prompt: 'done' },
                on: { done: { then: 'done' } },
              },
            },
          },
        },
      },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    });

    expect(config.orchestration.workflows.default).toBeDefined();
    expect(config).not.toHaveProperty('WakeConfig');
  });
});
