import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateMaintenanceLease } from '../../../src-next/bootstrap/update-maintenance-lease.js';

describe('update maintenance lease', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('atomically acquires and persists a quiescing attempt', async () => {
    const root = await createRoot(roots);
    const lease = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => 'attempt-1',
    );

    const acquired = await lease.acquire('v2.0.0');

    expect(acquired).toEqual({
      attemptId: 'attempt-1',
      tag: 'v2.0.0',
      phase: 'quiescing',
      startedAt: '2026-08-11T10:00:00.000Z',
    });
    expect(await lease.read()).toEqual(acquired);
    expect(
      JSON.parse(await readFile(join(root, '.wake', 'update-maintenance.json'), 'utf8')),
    ).toEqual(acquired);
  });

  it('retains the original attempt when acquisition is repeated', async () => {
    const root = await createRoot(roots);
    const lease = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => 'attempt-1',
    );
    await lease.acquire('v2.0.0');

    await expect(lease.acquire('v3.0.0')).resolves.toEqual({
      attemptId: 'attempt-1',
      tag: 'v2.0.0',
      phase: 'quiescing',
      startedAt: '2026-08-11T10:00:00.000Z',
    });
  });

  it('returns one complete, original lease when separate instances acquire concurrently', async () => {
    const root = await createRoot(roots);
    const first = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => 'attempt-1',
    );
    const second = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:01.000Z',
      () => 'attempt-2',
    );

    const [firstResult, secondResult] = await Promise.all([
      first.acquire(`v2.${'0'.repeat(5_000_000)}`),
      second.acquire(`v3.${'0'.repeat(5_000_000)}`),
    ]);

    expect(firstResult).toEqual(secondResult);
    expect(await first.read()).toEqual(firstResult);
    expect(await second.read()).toEqual(firstResult);
  });

  it('allows only forward maintenance phase transitions', async () => {
    const root = await createRoot(roots);
    const lease = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => 'attempt-1',
    );
    await lease.acquire('v2.0.0');

    await expect(lease.transition('updating')).resolves.toMatchObject({ phase: 'updating' });
    await expect(lease.transition('rolling-back')).resolves.toMatchObject({
      phase: 'rolling-back',
    });
    await expect(lease.transition('quiescing')).rejects.toThrow(
      'Invalid maintenance lease transition',
    );
  });

  it('marks a lease failed with operator-visible failure and can clear it', async () => {
    const root = await createRoot(roots);
    const lease = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => 'attempt-1',
    );
    await lease.acquire('v2.0.0');

    await expect(lease.fail(new Error('sandbox health check failed'))).resolves.toEqual({
      attemptId: 'attempt-1',
      tag: 'v2.0.0',
      phase: 'failed',
      startedAt: '2026-08-11T10:00:00.000Z',
      failure: 'sandbox health check failed',
    });
    await lease.clear();
    await expect(lease.read()).resolves.toBeNull();
  });

  it('persists a failure against a concurrent phase transition for a new reader', async () => {
    const root = await createRoot(roots);
    const writer = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => 'attempt-1',
    );
    const reader = createUpdateMaintenanceLease(root);
    await writer.acquire('v2.0.0');

    await Promise.allSettled([
      writer.fail(new Error('sandbox health check failed')),
      writer.transition('updating'),
    ]);

    await expect(reader.read()).resolves.toEqual({
      attemptId: 'attempt-1',
      tag: 'v2.0.0',
      phase: 'failed',
      startedAt: '2026-08-11T10:00:00.000Z',
      failure: 'sandbox health check failed',
    });
  });
});

async function createRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wake-update-maintenance-'));
  roots.push(root);
  return root;
}
