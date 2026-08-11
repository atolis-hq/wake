import { describe, expect, it } from 'vitest';
import { createSelfUpdateApplication } from '../../../src-next/bootstrap/self-update-application.js';

function ledger(lastHealthyTag: string | null, calls: string[] = []) {
  return {
    read: async () => lastHealthyTag,
    begin: async (tag: string) => {
      calls.push(`begin:${tag}`);
    },
    write: async (tag: string) => {
      calls.push(`ledger:${tag}`);
    },
    recover: async () => null,
    isBad: async () => false,
    recordBad: async (tag: string) => {
      calls.push(`bad:${tag}`);
    },
  };
}

describe('self-update application: update operations', () => {
  it('checks out immediately when the quiesce port observes no active Runs', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: source(calls),
      quiesce: quiesce(calls, [[]]),
      drainTimeoutMs: 100,
      cancellationTimeoutMs: 100,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'begin:v2',
      'phase:updating',
      'checkout:v2',
      'ledger:v2',
      'clear',
    ]);
  });

  it('requests durable maintenance cancellation after the drain grace expires', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: source(calls),
      quiesce: quiesce(calls, [['run-1'], ['run-1'], []]),
      drainTimeoutMs: 100,
      cancellationTimeoutMs: 100,
    });

    await expect(application.update('v2')).resolves.toBe(true);
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'sleep:100',
      'active',
      'cancel:run-1',
      'active',
      'begin:v2',
      'phase:updating',
      'checkout:v2',
      'ledger:v2',
      'clear',
    ]);
  });

  it('refuses to checkout when maintenance cancellation remains unconfirmed', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: source(calls),
      quiesce: quiesce(calls, [['run-1'], ['run-1'], ['run-1'], ['run-1']]),
      drainTimeoutMs: 100,
      cancellationTimeoutMs: 100,
    });

    await expect(application.update('v2')).rejects.toThrow('active Runs remain');
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'sleep:100',
      'active',
      'cancel:run-1',
      'active',
      'sleep:100',
      'active',
      'quiesce-failed:active Runs remain after maintenance cancellation: run-1',
      'bad:v2',
    ]);
  });

  it('surfaces a failed maintenance-lease write while retaining the unresolved Run context', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: source(calls),
      quiesce: quiesce(
        calls,
        [['run-1'], ['run-1'], ['run-1'], ['run-1']],
        new Error('maintenance lease store unavailable'),
      ),
      drainTimeoutMs: 100,
      cancellationTimeoutMs: 100,
    });

    const error = await application.update('v2').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Could not persist failed maintenance lease');
    expect((error as Error).message).toContain('maintenance lease store unavailable');
    expect((error as Error).message).toContain(
      'active Runs remain after maintenance cancellation: run-1',
    );
    expect((error as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'maintenance lease store unavailable',
    });
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'sleep:100',
      'active',
      'cancel:run-1',
      'active',
      'sleep:100',
      'active',
      'quiesce-failed:active Runs remain after maintenance cancellation: run-1',
      'bad:v2',
    ]);
  });

  it('refuses a dirty source checkout before applying any update', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => false,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async () => {
          calls.push('checkout');
        },
        healthy: async () => true,
      },
      quiesce: quiesce(calls, [[]]),
    });
    await expect(application.update('v2')).rejects.toThrow('clean source checkout');
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'quiesce-failed:Self-update requires a clean source checkout',
      'bad:v2',
    ]);
  });

  it('rolls back a failed health check and keeps the prior healthy ledger tag', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => false,
      },
    });
    await expect(application.update('v2')).rejects.toThrow('health verification');
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'checkout:v1', 'bad:v2']);
  });

  it('discovers a tag before applying a normal safe update', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({ tag: 'v2', updated: true });
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'ledger:v2']);
  });

  it('restores a pending update to the last healthy source revision before a new update', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), recover: async () => (calls.push('recover'), 'v1') },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
      quiesce: quiesce(calls, [[]]),
    });
    await application.update('v2');
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'recover',
      'checkout:v1',
      'begin:v2',
      'phase:updating',
      'checkout:v2',
      'ledger:v2',
      'clear',
    ]);
  });

  it('keeps an ambiguous Run as a drain blocker without attempting to cancel it', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: source(calls),
      quiesce: quiesce(calls, [[{ runId: 'run-ambiguous', maintenanceCancellable: false }]]),
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 0,
    });
    await expect(application.update('v2')).rejects.toThrow('run-ambiguous');
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'cancel:',
      'active',
      'quiesce-failed:active Runs remain after maintenance cancellation: run-ambiguous',
      'bad:v2',
    ]);
  });

  it('skips a known bad tag unless an operator explicitly forces a retry', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async () => true },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.update('v2')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('clears maintenance when the requested tag is already healthy', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v2', calls),
      source: source(calls),
      quiesce: quiesce(calls, [[]]),
    });
    await expect(application.update('v2')).resolves.toBe(false);
    expect(calls).toEqual(['quiesce:v2', 'active', 'clear']);
  });

  it('clears maintenance when the requested tag is already known bad', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async () => true },
      source: source(calls),
      quiesce: quiesce(calls, [[]]),
    });
    await expect(application.update('v2')).resolves.toBe(false);
    expect(calls).toEqual(['quiesce:v2', 'active', 'clear']);
  });
});

function source(calls: string[]) {
  return {
    isClean: async () => true,
    latestTag: async () => 'v2',
    candidateTags: async () => ['v2'],
    checkout: async (tag: string) => {
      calls.push(`checkout:${tag}`);
    },
    healthy: async () => true,
  };
}

function quiesce(
  calls: string[],
  activeRuns: readonly (
    | readonly string[]
    | readonly { readonly runId: string; readonly maintenanceCancellable: boolean }[]
  )[],
  failError?: Error,
) {
  let now = 0;
  let index = 0;
  return {
    acquire: async (tag: string) => {
      calls.push(`quiesce:${tag}`);
    },
    activeRuns: async () => {
      calls.push('active');
      return (activeRuns[Math.min(index++, activeRuns.length - 1)] ?? []).map((run) =>
        typeof run === 'string' ? { runId: run, maintenanceCancellable: true } : run,
      );
    },
    requestMaintenanceCancellation: async (runIds: readonly string[]) => {
      calls.push(`cancel:${runIds.join(',')}`);
    },
    sleep: async (milliseconds: number) => {
      calls.push(`sleep:${milliseconds}`);
      now += milliseconds;
    },
    now: () => now,
    fail: async (error: unknown) => {
      calls.push(`quiesce-failed:${error instanceof Error ? error.message : String(error)}`);
      if (failError !== undefined) throw failError;
    },
    transition: async (phase: string) => {
      calls.push(`phase:${phase}`);
    },
    clear: async () => {
      calls.push('clear');
    },
  };
}

describe('self-update application: updateLatest with bad tag handling', () => {
  it('skips bad candidate tags and updates to the first good one', async () => {
    const calls: string[] = [];
    const isBadMap: Record<string, boolean> = {
      'v2.0.0': true,
      'v1.9.0': true,
      'v1.8.0': false,
    };
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async (tag) => isBadMap[tag] ?? false },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2.0.0',
        candidateTags: async () => ['v2.0.0', 'v1.9.0', 'v1.8.0'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({
      tag: 'v1.8.0',
      updated: true,
    });
    expect(calls).toEqual(['begin:v1.8.0', 'checkout:v1.8.0', 'ledger:v1.8.0']);
  });

  it('reports no update when all candidate tags are bad', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: { ...ledger('v1', calls), isBad: async () => true },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2.0.0',
        candidateTags: async () => ['v2.0.0', 'v1.9.0'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({
      tag: 'v2.0.0',
      updated: false,
    });
    expect(calls).toEqual([]);
  });

  it('reports no update when already on a good candidate tag', async () => {
    const calls: string[] = [];
    const isBadMap: Record<string, boolean> = {
      'v2.0.0': true,
      'v1.0.0': false,
    };
    const application = createSelfUpdateApplication({
      ledger: {
        ...ledger('v1.0.0', calls),
        isBad: async (tag) => isBadMap[tag] ?? false,
      },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2.0.0',
        candidateTags: async () => ['v2.0.0', 'v1.0.0'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
    });
    await expect(application.updateLatest()).resolves.toEqual({
      tag: 'v1.0.0',
      updated: false,
    });
    expect(calls).toEqual([]);
  });
});

function rollout(calls: string[], deployError?: Error) {
  return {
    deploy: async (tag: string) => {
      calls.push(`deploy:${tag}`);
      if (deployError !== undefined) throw deployError;
    },
    rollback: async (tag: string) => {
      calls.push(`rollout-rollback:${tag}`);
    },
    recordFailure: async (tag: string, error: unknown) => {
      calls.push(`record:${tag}:${error instanceof Error ? error.message : String(error)}`);
    },
  };
}

describe('self-update application: Docker rollout', () => {
  it('deploys the sandbox container after a successful source checkout', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
      rollout: rollout(calls),
    });
    await expect(application.update('v2')).resolves.toBe(true);
    expect(calls).toEqual(['begin:v2', 'checkout:v2', 'deploy:v2', 'ledger:v2']);
  });

  it('rolls the container back and records the failure when a deploy fails', async () => {
    const calls: string[] = [];
    const deployError = new Error('docker build failed');
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => true,
      },
      rollout: rollout(calls, deployError),
    });
    await expect(application.update('v2')).rejects.toThrow('health verification');
    expect(calls).toEqual([
      'begin:v2',
      'checkout:v2',
      'deploy:v2',
      'checkout:v1',
      'rollout-rollback:v1',
      'record:v2:docker build failed',
      'bad:v2',
    ]);
  });

  it('marks maintenance failed after health failure and rollback', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: { ...source(calls), healthy: async () => false },
      quiesce: quiesce(calls, [[]]),
    });
    await expect(application.update('v2')).rejects.toThrow('health verification');
    expect(calls).toEqual([
      'quiesce:v2',
      'active',
      'begin:v2',
      'phase:updating',
      'checkout:v2',
      'phase:rolling-back',
      'checkout:v1',
      'quiesce-failed:Update v2 failed health verification',
      'bad:v2',
    ]);
  });

  it('never masks the original failure when recording itself fails', async () => {
    const calls: string[] = [];
    const application = createSelfUpdateApplication({
      ledger: ledger('v1', calls),
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => ['v2'],
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => false,
      },
      rollout: {
        deploy: async (tag) => {
          calls.push(`deploy:${tag}`);
        },
        rollback: async (tag) => {
          calls.push(`rollout-rollback:${tag}`);
        },
        recordFailure: async () => {
          throw new Error('disk write failed');
        },
      },
    });
    await expect(application.update('v2')).rejects.toThrow('health verification');
    expect(calls).toEqual([
      'begin:v2',
      'checkout:v2',
      'deploy:v2',
      'checkout:v1',
      'rollout-rollback:v1',
      'bad:v2',
    ]);
  });
});
