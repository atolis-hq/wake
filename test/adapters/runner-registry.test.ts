import { describe, expect, it } from 'vitest';

import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import {
  createRegistryRunner,
  resolveRunnerRouting,
} from '../../src/adapters/runner/runner-registry.js';

describe('runner registry routing', () => {
  it('resolves stage tiers to ordered named runner candidates', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-light'] = { kind: 'fake', cli: 'Fake Light' };
    config.runners['fake-deep'] = { kind: 'fake', cli: 'Fake Deep' };
    config.tiers.light = ['fake-light'];
    config.tiers.standard = ['fake-deep', 'fake-light'];
    config.stages.queue = { action: 'refine', tier: 'light' };
    config.stages.implement = { action: 'implement', tier: 'standard' };

    expect(resolveRunnerRouting({
      config,
      stage: 'queue',
      action: 'refine',
    })).toMatchObject({
      runnerName: 'fake-light',
      runnerKind: 'fake',
      tier: 'light',
    });

    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
    })).toMatchObject({
      runnerName: 'fake-deep',
      runnerKind: 'fake',
      tier: 'standard',
    });
  });

  it('keeps explicit stage runner pins legal', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners.pinned = { kind: 'fake', cli: 'Pinned Fake' };
    config.stages.implement = { action: 'implement', tier: 'standard', runner: 'pinned' };

    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
    })).toMatchObject({
      runnerName: 'pinned',
      runnerKind: 'fake',
      reason: 'stage implement pins runner pinned',
    });
  });

  it('executes through the registry path and stamps routing on the result', async () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-light'] = { kind: 'fake', cli: 'Fake Light' };
    config.tiers.light = ['fake-light'];
    config.stages.queue = { action: 'refine', tier: 'light' };

    const runner = createRegistryRunner({ config, cwd: process.cwd() });
    const result = await runner.run({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'atolis-hq/wake#1',
        issue: {
          repo: 'atolis-hq/wake',
          number: 1,
          title: 'Route',
          body: 'Body',
          labels: [],
          assignees: [],
          state: 'open',
          url: 'https://example.test/issues/1',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'queue',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
      },
      recentEvents: [],
      config,
      runId: 'run-1',
    });

    expect(result.cli).toBe('Fake Light');
    expect(result.routing).toMatchObject({
      runnerName: 'fake-light',
      runnerKind: 'fake',
      tier: 'light',
    });
  });
});
