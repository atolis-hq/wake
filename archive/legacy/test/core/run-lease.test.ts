import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createRunLease, renewRunLease } from '../../src/core/run-lease.js';

describe('run lease', () => {
  it('renews atomically only for the current owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wake-lease-'));
    try {
      const store = createStateStore({ wakeRoot: root });
      const lease = createRunLease({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        ownerInstanceId: 'instance-owner',
      });
      await store.writeRunRecord({
        schemaVersion: 1,
        runId: 'run-lease',
        workItemKey: 'work-01JZ0000000000000000000001',
        repo: 'atolis-hq/wake',
        issueNumber: 1,
        action: 'implement',
        lifecycle: 'RUNNING',
        status: 'running',
        startedAt: '2026-07-05T12:00:00.000Z',
        lease,
      });

      await expect(
        renewRunLease({
          stateStore: store,
          runId: 'run-lease',
          leaseId: lease.leaseId,
          ownerInstanceId: 'instance-other',
          clock: { now: () => new Date('2026-07-05T12:00:20.000Z') },
        }),
      ).resolves.toBe(false);
      expect((await store.readRunRecord('run-lease'))?.lease?.lastRenewedAt).toBe(
        '2026-07-05T12:00:00.000Z',
      );

      await expect(
        renewRunLease({
          stateStore: store,
          runId: 'run-lease',
          leaseId: lease.leaseId,
          ownerInstanceId: 'instance-owner',
          clock: { now: () => new Date('2026-07-05T12:00:20.000Z') },
        }),
      ).resolves.toBe(true);
      expect((await store.readRunRecord('run-lease'))?.lease?.lastRenewedAt).toBe(
        '2026-07-05T12:00:20.000Z',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
