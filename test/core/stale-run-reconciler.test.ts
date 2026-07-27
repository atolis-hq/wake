import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createStaleRunReconciler } from '../../src/core/stale-run-reconciler.js';
import { isRunLeaseExpired } from '../../src/core/run-lease.js';
import type { EventEnvelope, ExecutionAttemptLifecycle } from '../../src/domain/types.js';
import { processIdentityMatches } from '../../src/lib/process-identity.js';

const workId = 'work-01JZ0000000000000000000123';
const RUNNER_TIMEOUT_MS = 60_000;

function seedProjection(store: ReturnType<typeof createStateStore>, lastRunId: string) {
  return store.writeIssueState({
    schemaVersion: 1,
    workItemKey: workId,
    issue: {
      repo: 'atolis-hq/wake',
      number: 123,
      title: 'Stale run',
      body: 'Body',
      labels: ['wake'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/123',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:00:00.000Z',
    },
    comments: [],
    wake: {
      stage: 'implement',
      lastRunId,
      syncedAt: '2026-07-05T12:00:00.000Z',
      stageHistory: [],
      recentEventIds: [],
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {},
    correlatedResources: [],
  } as never);
}

function runningRecord(startedAt: string, lifecycle?: ExecutionAttemptLifecycle) {
  return {
    schemaVersion: 1 as const,
    runId: 'run-123-stale',
    workItemKey: workId,
    repo: 'atolis-hq/wake',
    issueNumber: 123,
    action: 'implement' as const,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    status: 'running' as const,
    startedAt,
  };
}

describe('stale run reconciler', () => {
  let root: string;
  let store: ReturnType<typeof createStateStore>;
  let delivered: EventEnvelope[];

  function reconciler() {
    const projectionUpdater = createProjectionUpdater({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config: createDefaultWakeConfig(root),
    });
    return createStaleRunReconciler({
      config: createDefaultWakeConfig(root),
      stateStore: store,
      projectionUpdater,
      runnerTimeoutMs: () => RUNNER_TIMEOUT_MS,
      deliverOutboundEvent: async (event) => {
        delivered.push(event);
      },
    });
  }

  function reconcilerWithInactiveRuns() {
    const projectionUpdater = createProjectionUpdater({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config: createDefaultWakeConfig(root),
    });
    return createStaleRunReconciler({
      config: createDefaultWakeConfig(root),
      stateStore: store,
      projectionUpdater,
      runnerTimeoutMs: () => RUNNER_TIMEOUT_MS,
      isRunningRecordActive: async () => false,
      deliverOutboundEvent: async (event) => {
        delivered.push(event);
      },
    });
  }

  function reconcilerWithLeaseAndProcessIdentity() {
    const projectionUpdater = createProjectionUpdater({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config: createDefaultWakeConfig(root),
    });
    return createStaleRunReconciler({
      config: createDefaultWakeConfig(root),
      stateStore: store,
      projectionUpdater,
      runnerTimeoutMs: () => RUNNER_TIMEOUT_MS,
      isRunningRecordActive: async (record, now) => {
        if (record.lease !== undefined && !isRunLeaseExpired(record, now)) {
          return true;
        }

        return (
          processIdentityMatches({
            pid: record.agentPid,
            processStartedAt: record.agentProcessStartedAt,
          }) ||
          processIdentityMatches({
            pid: record.workerPid,
            processStartedAt: record.workerProcessStartedAt,
          })
        );
      },
      deliverOutboundEvent: async (event) => {
        delivered.push(event);
      },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-stale-'));
    store = createStateStore({ wakeRoot: root });
    delivered = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('fails a stale running record the projection still points at', async () => {
    await seedProjection(store, 'run-123-stale');
    await store.writeRunRecord(runningRecord('2026-07-05T12:00:00.000Z'));

    await reconciler().reconcileStaleRunningRecords(new Date('2026-07-05T12:02:00.000Z'));

    const record = await store.readRunRecord('run-123-stale');
    expect(record?.status).toBe('failed');
    expect(record?.sentinel).toBe('FAILED');

    const completion = (await store.readEventEnvelope('run-123-stale-stale-reconciled'))!;
    expect(completion.payload.sentinel).toBe('FAILED');
    expect(delivered.map((e) => e.payload.statusLabel)).toContain('wake:status.failed');
  });

  it('preserves captured metadata on a reconciled record even though the staleness scan reads summaries', async () => {
    await seedProjection(store, 'run-123-stale');
    await store.writeRunRecord({
      ...runningRecord('2026-07-05T12:00:00.000Z'),
      metadata: { workspacePath: '/wake/.wake/repos/atolis-hq__wake', stdout: 'x'.repeat(5000) },
    });

    await reconciler().reconcileStaleRunningRecords(new Date('2026-07-05T12:02:00.000Z'));

    const record = await store.readRunRecord('run-123-stale');
    expect(record?.status).toBe('failed');
    expect(record?.metadata?.stdout).toBe('x'.repeat(5000));
    expect(record?.metadata?.workspacePath).toBe('/wake/.wake/repos/atolis-hq__wake');
    expect(record?.metadata?.reconciledBy).toBe('stale-running-record');
  });

  it('supersedes a stale record when a newer run has taken over', async () => {
    await seedProjection(store, 'run-123-newer');
    await store.writeRunRecord(runningRecord('2026-07-05T12:00:00.000Z'));

    await reconciler().reconcileStaleRunningRecords(new Date('2026-07-05T12:02:00.000Z'));

    const record = await store.readRunRecord('run-123-stale');
    expect(record?.status).toBe('superseded');
    expect(await store.readEventEnvelope('run-123-stale-stale-reconciled')).toBeNull();
    expect(delivered).toHaveLength(0);
  });

  it('leaves a running record that is not yet past the timeout untouched', async () => {
    await seedProjection(store, 'run-123-stale');
    await store.writeRunRecord(runningRecord('2026-07-05T12:01:30.000Z'));

    await reconciler().reconcileStaleRunningRecords(new Date('2026-07-05T12:02:00.000Z'));

    const record = await store.readRunRecord('run-123-stale');
    expect(record?.status).toBe('running');
    expect(delivered).toHaveLength(0);
  });

  it('fails a fresh running record immediately when no live runner owns it', async () => {
    await seedProjection(store, 'run-123-stale');
    await store.writeRunRecord(runningRecord('2026-07-05T12:01:30.000Z'));

    await reconcilerWithInactiveRuns().reconcileStaleRunningRecords(
      new Date('2026-07-05T12:02:00.000Z'),
    );

    const record = await store.readRunRecord('run-123-stale');
    expect(record?.status).toBe('failed');
    expect(record?.metadata?.reconciledBy).toBe('stale-running-record');
    expect(record?.metadata?.staleReason).toBe('runner-lock-not-active');

    const completion = (await store.readEventEnvelope('run-123-stale-stale-reconciled'))!;
    expect(completion.payload.reason).toBe('runner:orphaned-process');
  });

  it('recovers an expired leased run when the PID start identity does not match', async () => {
    await seedProjection(store, 'run-123-stale');
    await store.writeRunRecord({
      ...runningRecord('2026-07-05T12:01:30.000Z', 'RUNNING'),
      lease: {
        leaseId: 'lease-stale',
        ownerInstanceId: 'instance-old',
        acquiredAt: '2026-07-05T12:00:00.000Z',
        lastRenewedAt: '2026-07-05T12:00:00.000Z',
        expiresAt: '2026-07-05T12:01:00.000Z',
      },
      agentPid: process.pid,
      agentProcessStartedAt: 'linux-start-ticks:definitely-not-this-process',
    });

    await reconcilerWithLeaseAndProcessIdentity().reconcileStaleRunningRecords(
      new Date('2026-07-05T12:02:00.000Z'),
    );

    const record = await store.readRunRecord('run-123-stale');
    expect(record?.status).toBe('failed');
    expect(record?.metadata?.staleReason).toBe('runner-lock-not-active');
  });

  it.each([
    ['CREATED', 'CANCELED_BY_RECONCILIATION', 'runner:recover-created'],
    ['CLAIMED', 'CANCELED_BY_RECONCILIATION', 'runner:recover-claimed'],
    ['PREPARING', 'CANCELED_BY_RECONCILIATION', 'runner:recover-preparing'],
    ['PROCESS_STARTING', 'STALLED', 'runner:orphaned-process'],
    ['RUNNING', 'STALLED', 'runner:orphaned-process'],
    ['FINALISING', 'STALLED', 'runner:recover-finalising'],
  ] satisfies Array<[ExecutionAttemptLifecycle, string, string]>)(
    'recovers a %s execution attempt without launching a duplicate process',
    async (lifecycle, executionOutcome, reason) => {
      await seedProjection(store, 'run-123-stale');
      await store.writeRunRecord(runningRecord('2026-07-05T12:01:30.000Z', lifecycle));

      await reconcilerWithInactiveRuns().reconcileStaleRunningRecords(
        new Date('2026-07-05T12:02:00.000Z'),
      );

      const record = await store.readRunRecord('run-123-stale');
      expect(record?.status).toBe('failed');
      expect(record?.lifecycle).toBe('TERMINAL');
      expect(record?.executionOutcome).toBe(executionOutcome);
      expect(record?.metadata?.recoveryLifecycle).toBe(lifecycle);

      const completion = (await store.readEventEnvelope('run-123-stale-stale-reconciled'))!;
      expect(completion.payload.reason).toBe(reason);
      expect(completion.payload.executionOutcome).toBe(executionOutcome);
    },
  );

  it('recovers a claim projection whose run record is missing', async () => {
    await seedProjection(store, 'run-123-missing');

    await reconcilerWithInactiveRuns().reconcileStaleRunningRecords(
      new Date('2026-07-05T12:02:00.000Z'),
    );

    const completion = (await store.readEventEnvelope(
      'run-123-missing-missing-run-record-recovered',
    ))!;
    expect(completion.payload.reason).toBe('runner:missing-run-record');
    expect(completion.payload.executionOutcome).toBe('CANCELED_BY_RECONCILIATION');

    const projection = await store.readIssueState(workId);
    expect(projection?.context.lastRunSentinel).toBe('FAILED');
  });
});
