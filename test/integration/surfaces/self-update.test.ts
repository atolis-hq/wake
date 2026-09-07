import { describe, expect, it } from 'vitest';
import { createSelfUpdateApplication } from '../../../src/bootstrap/self-update-application.js';
import {
  runSelfUpdate,
  runSelfUpdateLatestLoop,
} from '../../../src/surfaces/cli/commands/self-update.js';

describe('self-update', () => {
  it('does not rerun an already-applied update without force', async () => {
    let updates = 0;
    await expect(
      runSelfUpdate({
        tag: 'v1',
        readLedger: async () => 'v1',
        writeLedger: async () => {},
        update: async () => {
          updates += 1;
        },
      }),
    ).resolves.toBe(false);
    expect(updates).toBe(0);
  });

  it('rolls back an unhealthy update without advancing the durable update ledger', async () => {
    const calls: string[] = [];
    await expect(
      runSelfUpdate({
        tag: 'v2',
        readLedger: async () => 'v1',
        writeLedger: async (tag) => {
          calls.push(`ledger:${tag}`);
        },
        update: async (tag) => {
          calls.push(`update:${tag}`);
        },
        health: async () => false,
        rollback: async (tag) => {
          calls.push(`rollback:${tag}`);
        },
      }),
    ).rejects.toThrow('Update v2 failed health verification');
    expect(calls).toEqual(['update:v2', 'rollback:v1']);
  });

  it('rolls back to the last healthy tag when applying the update throws', async () => {
    const calls: string[] = [];
    await expect(
      runSelfUpdate({
        tag: 'v2',
        readLedger: async () => 'v1',
        writeLedger: async () => {
          calls.push('ledger');
        },
        update: async (tag) => {
          calls.push(`update:${tag}`);
          throw new Error('checkout failed');
        },
        rollback: async (tag) => {
          calls.push(`rollback:${tag}`);
        },
      }),
    ).rejects.toThrow('checkout failed');
    expect(calls).toEqual(['update:v2', 'rollback:v1']);
  });

  it('continues after a failed update iteration until the injected wait boundary stops the loop', async () => {
    const { runSelfUpdateLoop } = await import('../../../src/surfaces/cli/commands/self-update.js');
    let updates = 0;
    let waits = 0;
    await expect(
      runSelfUpdateLoop(
        {
          tag: 'v2',
          readLedger: async () => 'v1',
          writeLedger: async () => {},
          update: async () => {
            updates += 1;
            if (updates === 1) throw new Error('transient');
          },
        },
        async () => {
          waits += 1;
          throw new Error('shutdown');
        },
      ),
    ).rejects.toThrow('shutdown');
    expect(updates).toBe(1);
    expect(waits).toBe(1);
  });

  it('discovers and attempts the latest update on every loop iteration', async () => {
    const tags: string[] = [];
    await expect(
      runSelfUpdateLatestLoop(
        async () => {
          tags.push('update');
        },
        async () => {
          throw new Error('shutdown');
        },
      ),
    ).rejects.toThrow('shutdown');
    expect(tags).toEqual(['update']);
  });

  it('reports each completed check and isolated failure to the loop log', async () => {
    const messages: string[] = [];
    let attempts = 0;
    let waits = 0;

    await expect(
      runSelfUpdateLatestLoop(
        async () => {
          attempts += 1;
          if (attempts === 1) return { tag: 'v2', updated: false };
          throw new Error('active runs are still draining');
        },
        async () => {
          waits += 1;
          if (waits === 2) throw new Error('shutdown');
        },
        (message) => messages.push(message),
      ),
    ).rejects.toThrow('shutdown');

    expect(messages).toEqual([
      'wake self-update: no eligible update v2',
      'wake self-update: active runs are still draining',
    ]);
  });

  it('skips a failed tag on the next loop iteration and applies a newly published tag once', async () => {
    const calls: string[] = [];
    const badTags = new Set<string>();
    let lease: { tag: string; phase: 'quiescing' | 'failed' } | null = null;
    let candidatesRead = 0;
    let healthy = false;
    const application = createSelfUpdateApplication({
      ledger: {
        read: async () => 'v1',
        begin: async (tag) => {
          calls.push(`begin:${tag}`);
        },
        write: async (tag) => {
          calls.push(`healthy:${tag}`);
        },
        recover: async () => null,
        isBad: async (tag) => badTags.has(tag),
        recordBad: async (tag) => {
          badTags.add(tag);
        },
      },
      source: {
        isClean: async () => true,
        latestTag: async () => 'v2',
        candidateTags: async () => {
          candidatesRead += 1;
          return candidatesRead === 1 ? ['v2'] : ['v2', 'v3'];
        },
        checkout: async (tag) => {
          calls.push(`checkout:${tag}`);
        },
        healthy: async () => healthy,
      },
      quiesce: {
        acquire: async (tag) => {
          if (lease?.phase === 'failed' && lease.tag !== tag) lease = null;
          lease ??= { tag, phase: 'quiescing' };
          calls.push(`lease:${lease.tag}`);
          return {
            attemptId: lease.tag,
            tag: lease.tag,
            phase: lease.phase,
            startedAt: '2026-08-11T10:00:00.000Z',
          };
        },
        activeRuns: async () => [],
        requestMaintenanceCancellation: async () => {},
        sleep: async () => {},
        now: () => 0,
        fail: async () => {
          if (lease !== null) lease = { ...lease, phase: 'failed' };
        },
        transition: async () => {},
        clear: async () => {
          lease = null;
        },
      },
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 0,
    });
    let waits = 0;

    await expect(
      runSelfUpdateLatestLoop(
        async () => {
          await application.updateLatest();
        },
        async () => {
          waits += 1;
          if (waits === 1) healthy = true;
          if (waits === 2) throw new Error('shutdown');
        },
      ),
    ).rejects.toThrow('shutdown');

    expect(calls).toEqual([
      'lease:v2',
      'begin:v2',
      'checkout:v2',
      'checkout:v1',
      'lease:v3',
      'begin:v3',
      'checkout:v3',
      'healthy:v3',
    ]);
    expect(badTags).toEqual(new Set(['v2']));
  });
});
