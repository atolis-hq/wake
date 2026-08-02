import { describe, expect, it } from 'vitest';
import {
  runSelfUpdate,
  runSelfUpdateLatestLoop,
} from '../../../src-next/surfaces/cli/commands/self-update.js';

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

  it('continues after a failed update iteration until the injected wait boundary stops the loop', async () => {
    const { runSelfUpdateLoop } =
      await import('../../../src-next/surfaces/cli/commands/self-update.js');
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
});
