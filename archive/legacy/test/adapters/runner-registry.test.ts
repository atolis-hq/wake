import { describe, expect, it } from 'vitest';

import {
  createRegistryRunner,
  resolveRunnerRouting,
} from '../../src/adapters/runner/runner-registry.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';

describe('runner registry routing', () => {
  it('resolves stage runnerPools to ordered named runner candidates', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-light'] = { kind: 'fake', cli: 'Fake Light' };
    config.runners['fake-deep'] = { kind: 'fake', cli: 'Fake Deep' };
    config.runnerPools.light = ['fake-light'];
    config.runnerPools.standard = ['fake-deep', 'fake-light'];

    expect(
      resolveRunnerRouting({
        config,
        stage: 'refine',
        action: 'refine',
      }),
    ).toMatchObject({
      runnerName: 'fake-light',
      runnerKind: 'fake',
      runnerPool: 'light',
    });

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
      }),
    ).toMatchObject({
      runnerName: 'fake-deep',
      runnerKind: 'fake',
      runnerPool: 'standard',
    });
  });

  it('falls sideways to the next runnerPool candidate when the primary runner is quota-paused (#67)', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runners['fake-secondary'] = { kind: 'fake', cli: 'Fake Secondary' };
    config.runnerPools.standard = ['fake-primary', 'fake-secondary'];

    const now = new Date('2026-07-07T22:30:00.000Z');
    const ledger = {
      schemaVersion: 1 as const,
      runners: {
        'fake-primary': { pausedUntil: '2026-07-07T23:00:00.000Z', failureCount: 1 },
      },
    };

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
        ledger,
        now,
      }),
    ).toMatchObject({ runnerName: 'fake-secondary' });

    // Rotation: once the pause expires, the primary is preferred again.
    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
        ledger,
        now: new Date('2026-07-07T23:00:01.000Z'),
      }),
    ).toMatchObject({ runnerName: 'fake-primary' });
  });

  it('allows an early recovery probe on an estimated pause once the probe interval elapses', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runnerPools.standard = ['fake-primary'];

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
    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
        ledger,
        now: new Date('2026-07-07T22:40:00.000Z'),
      }),
    ).toBeNull();

    // After the probe interval, but before the estimated pause fully elapses:
    // let a real attempt through as a recovery probe in case the guess overshot.
    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
        ledger,
        now: new Date('2026-07-07T22:46:00.000Z'),
      }),
    ).toMatchObject({
      runnerName: 'fake-primary',
      reason: expect.stringContaining('recovery probe'),
    });
  });

  it('does not probe early on a reported (real) reset time - trusts it for its full duration', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runnerPools.standard = ['fake-primary'];

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

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
        ledger,
        now: new Date('2026-07-07T23:00:00.000Z'),
      }),
    ).toBeNull();
  });

  it('returns null when every runnerPool candidate is quota-paused', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runners['fake-secondary'] = { kind: 'fake', cli: 'Fake Secondary' };
    config.runnerPools.standard = ['fake-primary', 'fake-secondary'];

    const now = new Date('2026-07-07T22:30:00.000Z');
    const ledger = {
      schemaVersion: 1 as const,
      runners: {
        'fake-primary': { pausedUntil: '2026-07-07T23:00:00.000Z', failureCount: 1 },
        'fake-secondary': { pausedUntil: '2026-07-07T23:05:00.000Z', failureCount: 1 },
      },
    };

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
        ledger,
        now,
      }),
    ).toBeNull();
  });

  it('keeps explicit stage runner pins legal', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners.pinned = { kind: 'fake', cli: 'Pinned Fake' };
    config.workflows.default!.stages.implement!.runner = 'pinned';

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
      }),
    ).toMatchObject({
      runnerName: 'pinned',
      runnerKind: 'fake',
      reason: 'stage implement pins runner pinned',
    });
  });

  it('uses the exact custom command route before falling back to shared action routing', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-review'] = { kind: 'fake', cli: 'Fake Review' };
    config.runners['fake-inspect'] = { kind: 'fake', cli: 'Fake Inspect' };
    config.runnerPools.standard = ['fake-review'];
    config.runnerPools.deep = ['fake-inspect'];
    config.commands.codereview = {
      action: 'codereview',
      workspace: 'read-only',
      runnerPool: 'standard',
    };
    config.commands.inspect = {
      action: 'codereview',
      workspace: 'read-only',
      runnerPool: 'deep',
    };

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'codereview',
        command: 'inspect',
      }),
    ).toMatchObject({
      runnerName: 'fake-inspect',
      runnerPool: 'deep',
      reason: 'command codereview runnerPool deep selected runner fake-inspect',
    });
  });

  it('uses workflow stage routing for stage runner selection', () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-workflow'] = { kind: 'fake', cli: 'Fake Workflow' };
    config.runnerPools.standard = ['fake-workflow'];
    config.workflows.default!.stages.implement!.runnerPool = 'standard';

    expect(
      resolveRunnerRouting({
        config,
        stage: 'implement',
        action: 'implement',
      }),
    ).toMatchObject({
      runnerName: 'fake-workflow',
      runnerPool: 'standard',
    });
  });

  it('executes through the registry path and stamps routing on the result', async () => {
    const config = createDefaultWakeConfig('/tmp/wake');
    config.runners['fake-light'] = { kind: 'fake', cli: 'Fake Light' };
    config.runnerPools.light = ['fake-light'];

    const runner = createRegistryRunner({ config, cwd: process.cwd() });
    const result = await runner.run({
      action: 'refine',
      projection: {
        schemaVersion: 1,
        workItemKey: 'work-01JQZX9K2N4P6R8T0V2W4Y6A01',
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
        correlatedResources: [],
      },
      recentEvents: [],
      config,
      runId: 'run-1',
    });

    expect(result.cli).toBe('Fake Light');
    expect(result.routing).toMatchObject({
      runnerName: 'fake-light',
      runnerKind: 'fake',
      runnerPool: 'light',
    });
  });
});
