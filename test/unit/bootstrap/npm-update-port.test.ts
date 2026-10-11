import { describe, expect, it } from 'vitest';
import { createNpmUpdatePort } from '../../../src/bootstrap/npm-update-port.js';
import { createSelfUpdateApplication } from '../../../src/bootstrap/self-update-application.js';
import { UpdateMaintenancePhase } from '../../../src/bootstrap/update-maintenance-lease.js';

describe('npm update port', () => {
  it('resolves the configured dist-tag to an exact immutable version', async () => {
    const calls: string[][] = [];
    const port = createNpmUpdatePort({
      packageName: '@atolis-hq/wake',
      distTag: 'next',
      registry: 'https://registry.example.test',
      execute: async (_command, args) => {
        calls.push([...args]);
        return '["1.2.3"]';
      },
    });
    await expect(port.candidateTags()).resolves.toEqual(['1.2.3']);
    expect(calls).toEqual([
      [
        'view',
        '@atolis-hq/wake@next',
        'version',
        '--json',
        '--registry=https://registry.example.test',
      ],
    ]);
  });

  it('does not overwrite the coordinating CLI while preparing a package update', async () => {
    const port = createNpmUpdatePort({
      packageName: '@atolis-hq/wake',
      execute: async () => '"1.2.3"',
    });
    await expect(port.checkout('1.2.3')).resolves.toBeUndefined();
    await expect(port.healthy()).resolves.toBe(true);
  });

  it('rejects malformed registry metadata', async () => {
    const port = createNpmUpdatePort({
      packageName: '@atolis-hq/wake',
      execute: async () => '"latest"',
    });
    await expect(port.candidateTags()).rejects.toThrow('npm returned an invalid version');
  });
});

function packagedApplication(deployed: string, bad = false, fail = false, maintenance = false) {
  const calls: string[] = [];
  let current = deployed;
  const port = createNpmUpdatePort({
    packageName: '@atolis-hq/wake',
    execute: async () => '"1.2.3"',
  });
  const application = createSelfUpdateApplication({
    source: {
      ...port,
      currentTag: async () => '1.2.3',
      healthy: async () => {
        if (maintenance) calls.push('health');
        return true;
      },
    },
    ...(maintenance
      ? {
          quiesce: {
            acquire: async (tag: string) => {
              calls.push('acquire');
              return {
                tag,
                attemptId: 'attempt-1',
                phase: UpdateMaintenancePhase.Quiescing,
                startedAt: '2026-10-11T00:00:00Z',
              };
            },
            activeRuns: async () => {
              calls.push('active');
              return [];
            },
            sleep: async () => {},
            now: () => 0,
            transition: async (phase: string) => {
              calls.push(phase);
            },
            clear: async () => {
              calls.push('clear');
            },
            fail: async () => {
              calls.push('failed');
            },
          },
        }
      : {}),
    ledger: {
      read: async () => current,
      begin: async (tag) => {
        calls.push('begin:' + tag);
      },
      write: async (tag) => {
        current = tag;
        calls.push('ledger:' + tag);
      },
      recover: async () => null,
      isBad: async () => bad,
      recordBad: async (tag) => {
        calls.push('bad:' + tag);
      },
    },
    rollout: {
      prepare: async (tag) => {
        calls.push('prepare:' + tag);
      },
      deploy: async (tag) => {
        calls.push('deploy:' + tag);
        if (fail) throw new Error('deploy failed');
      },
      rollback: async (tag) => {
        calls.push('rollback:' + tag);
      },
      recordFailure: async (tag) => {
        calls.push('failure:' + tag);
      },
    },
  });
  return { application, calls };
}

describe('packaged deployment version selection', () => {
  it('prepares before maintenance and verifies health before resuming', async () => {
    const { application, calls } = packagedApplication('1.2.2', false, false, true);
    await expect(application.updateLatest()).resolves.toEqual({ tag: '1.2.3', updated: true });
    expect(calls).toEqual([
      'prepare:1.2.3',
      'acquire',
      'active',
      'begin:1.2.3',
      UpdateMaintenancePhase.Updating,
      'deploy:1.2.3',
      'health',
      'ledger:1.2.3',
      'clear',
    ]);
  });

  it('deploys behind the host CLI and skips subsequent recurring checks', async () => {
    const { application, calls } = packagedApplication('1.2.2');
    await expect(application.updateLatest()).resolves.toEqual({ tag: '1.2.3', updated: true });
    expect(calls).toEqual(['prepare:1.2.3', 'begin:1.2.3', 'deploy:1.2.3', 'ledger:1.2.3']);
    await expect(application.updateLatest()).resolves.toEqual({ tag: '1.2.3', updated: false });
    expect(calls).toHaveLength(4);
  });

  it('deploys an explicit version matching the host without force', async () => {
    const { application, calls } = packagedApplication('1.2.2');
    await expect(application.update('1.2.3')).resolves.toBe(true);
    expect(calls).toContain('deploy:1.2.3');
  });

  it('allows an explicit newer release outside the configured dist-tag', async () => {
    const { application, calls } = packagedApplication('1.2.2');
    await expect(application.update('1.2.4')).resolves.toBe(true);
    expect(calls).toContain('deploy:1.2.4');
  });

  it.each(['1.2.3', '1.2.4', '1.10.0', '2.0.0'])(
    'never reapplies or downgrades deployment %s, even forced',
    async (deployed) => {
      const { application, calls } = packagedApplication(deployed);
      for (const force of [false, true]) {
        await expect(application.updateLatest(force)).resolves.toEqual({
          tag: '1.2.3',
          updated: false,
        });
        await expect(application.update('1.2.3', force)).resolves.toBe(false);
      }
      expect(calls).toEqual([]);
    },
  );

  it('protects failed releases unless forced', async () => {
    const { application, calls } = packagedApplication('1.2.2', true);
    await expect(application.updateLatest()).resolves.toEqual({ tag: '1.2.3', updated: false });
    await expect(application.update('1.2.3')).resolves.toBe(false);
    expect(calls).toEqual([]);
    await expect(application.updateLatest(true)).resolves.toEqual({ tag: '1.2.3', updated: true });
  });

  it('rolls back a failed deployment to the ledger version', async () => {
    const { application, calls } = packagedApplication('1.2.2', false, true);
    await expect(application.updateLatest()).resolves.toEqual({ tag: '1.2.3', updated: false });
    expect(calls).toEqual([
      'prepare:1.2.3',
      'begin:1.2.3',
      'deploy:1.2.3',
      'rollback:1.2.2',
      'failure:1.2.3',
      'bad:1.2.3',
    ]);
  });
});
