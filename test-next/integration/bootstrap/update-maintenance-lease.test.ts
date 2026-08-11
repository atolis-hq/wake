import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSelfUpdateApplication } from '../../../src-next/bootstrap/self-update-application.js';
import { createUpdateLedger } from '../../../src-next/bootstrap/update-ledger.js';
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

  it('atomically replaces a failed attempt only for a different candidate tag', async () => {
    const root = await createRoot(roots);
    let attempt = 0;
    const lease = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => `attempt-${++attempt}`,
    );
    await lease.acquire('v2.0.0');
    await lease.fail(new Error('v2 failed'));

    await expect(lease.acquire('v2.0.0')).resolves.toMatchObject({
      attemptId: 'attempt-1',
      tag: 'v2.0.0',
      phase: 'failed',
    });
    await expect(lease.acquire('v3.0.0')).resolves.toEqual({
      attemptId: 'attempt-2',
      tag: 'v3.0.0',
      phase: 'quiescing',
      startedAt: '2026-08-11T10:00:00.000Z',
    });
  });

  it('replaces a failed attempt for the same tag only when force explicitly retries it', async () => {
    const root = await createRoot(roots);
    let attempt = 0;
    const lease = createUpdateMaintenanceLease(
      root,
      () => '2026-08-11T10:00:00.000Z',
      () => `attempt-${++attempt}`,
    );
    await lease.acquire('v2.0.0');
    await lease.fail(new Error('v2 failed'));

    await expect(lease.acquire('v2.0.0', true)).resolves.toMatchObject({
      attemptId: 'attempt-2',
      tag: 'v2.0.0',
      phase: 'quiescing',
    });
  });

  it('recovers a persisted updating attempt once, marks it bad, then applies a newer candidate once', async () => {
    const root = await createRoot(roots);
    const maintenance = createUpdateMaintenanceLease(root, () => '2026-08-11T10:00:00.000Z');
    const ledger = createUpdateLedger(root);
    await ledger.write('v1');
    await ledger.begin('v2');
    await maintenance.acquire('v2');
    await maintenance.transition('updating');
    const checkouts: string[] = [];
    const application = createSelfUpdateApplication({
      ledger,
      source: {
        isClean: async () => true,
        latestTag: async () => 'v3',
        candidateTags: async () => ['v2', 'v3'],
        checkout: async (tag) => {
          checkouts.push(tag);
        },
        healthy: async () => true,
      },
      quiesce: persistedQuiesce(maintenance),
      drainTimeoutMs: 0,
      cancellationTimeoutMs: 0,
    });

    await expect(application.update('v2')).resolves.toBe(false);
    await expect(ledger.isBad('v2')).resolves.toBe(true);
    await expect(maintenance.read()).resolves.toBeNull();
    await expect(application.updateLatest()).resolves.toEqual({ tag: 'v3', updated: true });
    expect(checkouts).toEqual(['v1', 'v3']);
  });

  it('lets only one concurrent self-update caller perform the forward checkout', async () => {
    const root = await createRoot(roots);
    const maintenance = createUpdateMaintenanceLease(root);
    const ledger = createUpdateLedger(root);
    const checkouts: string[] = [];
    let releaseFirstCheckout: (() => void) | undefined;
    let firstCheckoutStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstCheckoutStarted = resolve;
    });
    const source = {
      isClean: async () => true,
      latestTag: async () => 'v2',
      candidateTags: async () => ['v2'],
      checkout: async (tag: string) => {
        checkouts.push(tag);
        if (tag !== 'v2' || checkouts.filter((value) => value === 'v2').length !== 1) return;
        firstCheckoutStarted?.();
        await new Promise<void>((resolve) => {
          releaseFirstCheckout = resolve;
        });
      },
      healthy: async () => true,
    };
    const quiesce = exclusivePersistedQuiesce(maintenance);
    const first = createSelfUpdateApplication({ ledger, source, quiesce }).update('v2');
    await firstStarted;
    const second = createSelfUpdateApplication({ ledger, source, quiesce }).update('v2');
    releaseFirstCheckout?.();

    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(checkouts.filter((tag) => tag === 'v2')).toEqual(['v2']);
    await expect(maintenance.read()).resolves.toBeNull();
  });

  it('refuses to clear a replacement lease from the displaced attempt', async () => {
    const root = await createRoot(roots);
    let attempt = 0;
    const maintenance = createUpdateMaintenanceLease(root, undefined, () => `attempt-${++attempt}`);
    const failed = await maintenance.acquire('v2');
    await maintenance.fail(new Error('failed'), failed.attemptId);
    const replacement = await maintenance.acquire('v3');

    await expect(maintenance.clear(failed.attemptId)).rejects.toThrow('no longer owns the lease');
    await expect(maintenance.read()).resolves.toEqual(replacement);
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

function persistedQuiesce(maintenance: ReturnType<typeof createUpdateMaintenanceLease>) {
  return {
    acquire: (tag: string, retryFailed?: boolean) => maintenance.acquire(tag, retryFailed),
    activeRuns: async () => [],
    requestMaintenanceCancellation: async () => {},
    sleep: async () => {},
    now: () => 0,
    fail: async (error: unknown) => {
      await maintenance.fail(error);
    },
    transition: async (phase: 'updating' | 'rolling-back') => {
      await maintenance.transition(phase);
    },
    clear: () => maintenance.clear(),
  };
}

function exclusivePersistedQuiesce(maintenance: ReturnType<typeof createUpdateMaintenanceLease>) {
  return {
    ...persistedQuiesce(maintenance),
    exclusive: <Value>(
      tag: string,
      retryFailed: boolean,
      operation: (state: Awaited<ReturnType<typeof maintenance.acquire>>) => Promise<Value>,
    ) => maintenance.runExclusive(tag, retryFailed, operation),
  };
}
