import { describe, expect, it } from 'vitest';
import { parseRootConfig } from '../../../src-next/bootstrap/config/root-schema.js';

describe('root configuration', () => {
  it('keeps workflow configuration in the orchestration subtree', () => {
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
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

function orchestration(subtree: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    work: {},
    resources: {},
    execution: {
      agentRunners: { fake: { kind: 'fake' } },
      runnerPools: { standard: ['fake'] },
      defaultRunnerPool: 'standard',
    },
    orchestration: {
      workflows: {
        default: { stages: { done: { activity: 'agent', on: { done: { then: 'done' } } } } },
        review: { stages: { done: { activity: 'agent', on: { done: { then: 'done' } } } } },
      },
      ...subtree,
    },
    controlPlane: {},
    integrations: {},
    surfaces: {},
  };
}

describe('workflow routing configuration', () => {
  it('defaults the routing fallback and the selector list', () => {
    const config = parseRootConfig(orchestration({}));

    expect(config.orchestration.default).toBe('default');
    expect(config.orchestration.workflowSelectors).toEqual([]);
  });

  it('keeps a configured default and selector list', () => {
    const config = parseRootConfig(
      orchestration({
        default: 'review',
        workflowSelectors: [{ match: { tags: ['review'] }, workflow: 'review' }],
      }),
    );

    expect(config.orchestration.default).toBe('review');
    expect(config.orchestration.workflowSelectors[0]?.workflow).toBe('review');
  });

  it('rejects a default naming a workflow that is not configured', () => {
    expect(() => parseRootConfig(orchestration({ default: 'missing' }))).toThrow(/missing/);
  });

  it('rejects a selector naming a workflow that is not configured', () => {
    expect(() =>
      parseRootConfig(
        orchestration({ workflowSelectors: [{ match: { tags: ['x'] }, workflow: 'missing' }] }),
      ),
    ).toThrow(/missing/);
  });

  it('still accepts an orchestration subtree with no workflows at all', () => {
    const config = parseRootConfig({
      schemaVersion: 1,
      work: {},
      resources: {},
      execution: {
        agentRunners: { fake: { kind: 'fake' } },
        runnerPools: { standard: ['fake'] },
        defaultRunnerPool: 'standard',
      },
      orchestration: { workflows: {} },
      controlPlane: {},
      integrations: {},
      surfaces: {},
    });

    expect(config.orchestration.workflows).toEqual({});
  });
});
