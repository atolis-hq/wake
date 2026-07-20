import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createStaleRunReconciler } from '../../src/core/stale-run-reconciler.js';
import type { EventEnvelope } from '../../src/domain/types.js';

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

function runningRecord(startedAt: string) {
  return {
    schemaVersion: 1 as const,
    runId: 'run-123-stale',
    workItemKey: workId,
    repo: 'atolis-hq/wake',
    issueNumber: 123,
    action: 'implement' as const,
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
});
