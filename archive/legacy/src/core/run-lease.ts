import { randomUUID } from 'node:crypto';

import type { RunRecord } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;

export const runLeaseDurationMs = 60_000;
export const runLeaseRenewalIntervalMs = 20_000;

export function createRunLease(input: { clock: Clock; ownerInstanceId: string }) {
  const acquiredAt = input.clock.now();
  const expiresAt = new Date(acquiredAt.getTime() + runLeaseDurationMs);

  return {
    leaseId: `lease-${randomUUID()}`,
    ownerInstanceId: input.ownerInstanceId,
    acquiredAt: acquiredAt.toISOString(),
    lastRenewedAt: acquiredAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function isRunLeaseExpired(record: RunRecord, now: Date): boolean {
  if (record.lease === undefined) {
    return true;
  }

  return Date.parse(record.lease.expiresAt) <= now.getTime();
}

export async function renewRunLease(input: {
  stateStore: StateStore;
  runId: string;
  leaseId: string;
  ownerInstanceId: string;
  clock: Clock;
}): Promise<boolean> {
  const now = input.clock.now();
  const renewed = await input.stateStore.updateRunRecordIf(input.runId, {
    expect: (record) =>
      record.status === 'running' &&
      record.lifecycle !== 'TERMINAL' &&
      record.lease?.leaseId === input.leaseId &&
      record.lease.ownerInstanceId === input.ownerInstanceId,
    update: (record) => ({
      ...record,
      lease: {
        ...record.lease!,
        lastRenewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + runLeaseDurationMs).toISOString(),
      },
    }),
  });
  return renewed !== null;
}
