import { describe, expect, it } from 'vitest';
import { createGitHubAdapterHealthRegistry } from '../../../../src/integrations/github/infrastructure/adapter-health-registry.js';

describe('createGitHubAdapterHealthRegistry', () => {
  it('pre-seeds a read and write check for every configured repository', () => {
    const registry = createGitHubAdapterHealthRegistry([
      { owner: 'atolis-hq', repo: 'wake' },
      { owner: 'atolis-hq', repo: 'other' },
    ]);

    const checks = registry.snapshotAll();

    expect(checks).toHaveLength(4);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'atolis-hq/wake', channel: 'poll', status: 'ok' }),
        expect.objectContaining({ scope: 'atolis-hq/wake', channel: 'deliver', status: 'ok' }),
        expect.objectContaining({ scope: 'atolis-hq/other', channel: 'poll', status: 'ok' }),
        expect.objectContaining({ scope: 'atolis-hq/other', channel: 'deliver', status: 'ok' }),
      ]),
    );
  });

  it('routes success and failure to the tracker for that scope and channel only', () => {
    const registry = createGitHubAdapterHealthRegistry([
      { owner: 'atolis-hq', repo: 'wake' },
      { owner: 'atolis-hq', repo: 'other' },
    ]);

    registry.recordFailure(
      'atolis-hq/wake',
      'poll',
      Object.assign(new Error('down'), { status: 429 }),
    );
    registry.recordSuccess('atolis-hq/other', 'deliver');

    const checks = registry.snapshotAll();
    const wakeRead = checks.find((c) => c.scope === 'atolis-hq/wake' && c.channel === 'poll')!;
    const wakeWrite = checks.find((c) => c.scope === 'atolis-hq/wake' && c.channel === 'deliver')!;
    const otherWrite = checks.find(
      (c) => c.scope === 'atolis-hq/other' && c.channel === 'deliver',
    )!;

    expect(wakeRead.status).toBe('degraded');
    expect(wakeRead.failureCount).toBe(1);
    expect(wakeWrite.status).toBe('ok');
    expect(otherWrite.successCount).toBe(1);
  });

  it('lazily tracks a scope that was not pre-seeded', () => {
    const registry = createGitHubAdapterHealthRegistry([]);

    registry.recordSuccess('atolis-hq/unlisted', 'poll');

    const checks = registry.snapshotAll();
    expect(checks).toEqual([
      expect.objectContaining({ scope: 'atolis-hq/unlisted', channel: 'poll', successCount: 1 }),
    ]);
  });
});
