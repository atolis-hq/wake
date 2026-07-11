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

  it('falls sideways to the next tier candidate when the primary runner is quota-paused (#67)', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runners['fake-secondary'] = { kind: 'fake', cli: 'Fake Secondary' };
    config.tiers.standard = ['fake-primary', 'fake-secondary'];
    config.stages.implement = { action: 'implement', tier: 'standard' };

    const now = new Date('2026-07-07T22:30:00.000Z');
    const ledger = {
      schemaVersion: 1 as const,
      runners: {
        'fake-primary': { pausedUntil: '2026-07-07T23:00:00.000Z', failureCount: 1 },
      },
    };

    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
      ledger,
      now,
    })).toMatchObject({ runnerName: 'fake-secondary' });

    // Rotation: once the pause expires, the primary is preferred again.
    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
      ledger,
      now: new Date('2026-07-07T23:00:01.000Z'),
    })).toMatchObject({ runnerName: 'fake-primary' });
  });

  it('allows an early recovery probe on an estimated pause once the probe interval elapses', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.tiers.standard = ['fake-primary'];
    config.stages.implement = { action: 'implement', tier: 'standard' };

    const lastFailureAt = '2026-07-07T22:30:00.000Z';
    const ledger = {
      schemaVersion: 1 as const,
      runners: {
        // A 1-hour estimated pause (backoff guess, not a real reported reset time).
        'fake-primary': {
          pausedUntil: '2026-07-07T23:30:00.000Z',
          pausedUntilSource: 'estimated' as const,
          failureCount: 3,
          lastFailureAt,
        },
      },
    };

    // Before the 15-minute probe interval: still fully paused.
    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
      ledger,
      now: new Date('2026-07-07T22:40:00.000Z'),
    })).toBeNull();

    // After the probe interval, but before the estimated pause fully elapses:
    // let a real attempt through as a recovery probe in case the guess overshot.
    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
      ledger,
      now: new Date('2026-07-07T22:46:00.000Z'),
    })).toMatchObject({
      runnerName: 'fake-primary',
      reason: expect.stringContaining('recovery probe'),
    });
  });

  it('does not probe early on a reported (real) reset time - trusts it for its full duration', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.tiers.standard = ['fake-primary'];
    config.stages.implement = { action: 'implement', tier: 'standard' };

    const ledger = {
      schemaVersion: 1 as const,
      runners: {
        'fake-primary': {
          pausedUntil: '2026-07-07T23:30:00.000Z',
          pausedUntilSource: 'reported' as const,
          failureCount: 1,
          lastFailureAt: '2026-07-07T22:30:00.000Z',
        },
      },
    };

    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
      ledger,
      now: new Date('2026-07-07T23:00:00.000Z'),
    })).toBeNull();
  });

  it('returns null when every tier candidate is quota-paused', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runners['fake-secondary'] = { kind: 'fake', cli: 'Fake Secondary' };
    config.tiers.standard = ['fake-primary', 'fake-secondary'];
    config.stages.implement = { action: 'implement', tier: 'standard' };

    const now = new Date('2026-07-07T22:30:00.000Z');
    const ledger = {
      schemaVersion: 1 as const,
      runners: {
        'fake-primary': { pausedUntil: '2026-07-07T23:00:00.000Z', failureCount: 1 },
        'fake-secondary': { pausedUntil: '2026-07-07T23:05:00.000Z', failureCount: 1 },
      },
    };

    expect(resolveRunnerRouting({
      config,
      stage: 'implement',
      action: 'implement',
      ledger,
      now,
    })).toBeNull();
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
          isPullRequest: false,
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
