import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createResourceIndex } from '../../src/adapters/fs/resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { runCorrelateCommand } from '../../src/cli/correlate-command.js';
import { CORRELATION_PRIMARY_CONFLICT_EVENT } from '../../src/domain/schema.js';
import type { IssueStateRecord } from '../../src/domain/types.js';
import { readFlagBeforeCommandTerminator } from '../../src/main.js';

function workId(seed: number): string {
  return `work-01JZ${String(seed).padStart(22, '0')}`;
}

function issueState(input: { workItemKey: string }): IssueStateRecord {
  return {
    schemaVersion: 1,
    workItemKey: input.workItemKey,
    origin: 'github',
    issue: {
      repo: 'atolis-hq/wake',
      number: 7,
      title: 'Spec',
      body: 'Body',
      labels: ['wake:queue'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: 'https://example.test/issues/7',
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:00:00.000Z',
    },
    comments: [],
    wake: {
      stage: 'queue',
      stageHistory: [{ stage: 'queue', changedAt: '2026-07-05T12:00:00.000Z', reason: 'test' }],
      recentEventIds: [],
      syncedAt: '2026-07-05T12:00:00.000Z',
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {},
    correlatedResources: [],
  };
}

describe('wake correlate', () => {
  let wakeRoot: string;
  let stateStore: ReturnType<typeof createStateStore>;
  let resourceIndex: ReturnType<typeof createResourceIndex>;
  const clock = { now: () => new Date('2026-07-17T09:00:00.000Z') };

  beforeEach(async () => {
    wakeRoot = await mkdtemp(join(tmpdir(), 'wake-correlate-'));
    stateStore = createStateStore({ wakeRoot });
    await stateStore.ensureWakeRoot();
    resourceIndex = createResourceIndex({ paths: stateStore.paths });
  });

  it('registers a resource against an existing work item as operator-declared primary', async () => {
    const key = workId(1);
    await stateStore.writeIssueState(issueState({ workItemKey: key }));

    await runCorrelateCommand({
      args: [key, 'github:pr:123'],
      stateStore,
      resourceIndex,
      clock,
      readFlag: readFlagBeforeCommandTerminator,
      log: () => {},
    });

    const projection = await stateStore.readIssueState(key);
    expect(projection?.correlatedResources).toEqual([
      expect.objectContaining({
        resourceUri: 'github:pr:123',
        role: 'implementation',
        relation: 'primary',
        provenance: 'operator-declared',
      }),
    ]);
    await expect(resourceIndex.resolve('github:pr:123')).resolves.toBe(key);
  });

  it('rejects a malformed resourceUri', async () => {
    const key = workId(2);
    await stateStore.writeIssueState(issueState({ workItemKey: key }));

    await expect(
      runCorrelateCommand({
        args: [key, 'not-a-valid-uri'],
        stateStore,
        resourceIndex,
        clock,
        readFlag: readFlagBeforeCommandTerminator,
        log: () => {},
      }),
    ).rejects.toThrow(/resourceUri/i);
  });

  it('rejects an unknown workItemKey rather than creating a phantom work item', async () => {
    await expect(
      runCorrelateCommand({
        args: ['work-01JZDOESNOTEXIST00000000000', 'github:pr:999'],
        stateStore,
        resourceIndex,
        clock,
        readFlag: readFlagBeforeCommandTerminator,
        log: () => {},
      }),
    ).rejects.toThrow(/unknown workitemkey/i);

    expect(await stateStore.readIssueState('work-01JZDOESNOTEXIST00000000000')).toBeNull();
  });

  it('honours an explicit --role flag', async () => {
    const key = workId(3);
    await stateStore.writeIssueState(issueState({ workItemKey: key }));

    await runCorrelateCommand({
      args: [key, 'github:pr:456', '--role', 'review'],
      stateStore,
      resourceIndex,
      clock,
      readFlag: readFlagBeforeCommandTerminator,
      log: () => {},
    });

    const projection = await stateStore.readIssueState(key);
    expect(projection?.correlatedResources[0]?.role).toBe('review');
  });

  it('rejects an invalid --role', async () => {
    const key = workId(4);
    await stateStore.writeIssueState(issueState({ workItemKey: key }));

    await expect(
      runCorrelateCommand({
        args: [key, 'github:pr:789', '--role', 'not-a-real-role'],
        stateStore,
        resourceIndex,
        clock,
        readFlag: readFlagBeforeCommandTerminator,
        log: () => {},
      }),
    ).rejects.toThrow(/role/i);
  });

  it('downgrades to secondary and emits a conflict event when the uri is already primary elsewhere', async () => {
    const incumbentKey = workId(5);
    const challengerKey = workId(6);
    await stateStore.writeIssueState(issueState({ workItemKey: incumbentKey }));
    await stateStore.writeIssueState(issueState({ workItemKey: challengerKey }));
    await resourceIndex.register('github:pr:321', incumbentKey);

    await runCorrelateCommand({
      args: [challengerKey, 'github:pr:321'],
      stateStore,
      resourceIndex,
      clock,
      readFlag: readFlagBeforeCommandTerminator,
      log: () => {},
    });

    const projection = await stateStore.readIssueState(challengerKey);
    expect(projection?.correlatedResources).toEqual([
      expect.objectContaining({
        resourceUri: 'github:pr:321',
        relation: 'secondary',
        provenance: 'operator-declared',
      }),
    ]);

    // The index must still credit the incumbent — a downgraded registration
    // must never steal the uri.
    await expect(resourceIndex.resolve('github:pr:321')).resolves.toBe(incumbentKey);

    const events = await stateStore.listEventEnvelopes();
    const conflictEvent = events.find(
      (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT,
    );
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent?.workItemKey).toBe(challengerKey);
    expect(conflictEvent?.payload).toMatchObject({
      resourceUri: 'github:pr:321',
      incumbentWorkItemKey: incumbentKey,
    });
  });
});
