import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { buildBoard, buildConfigView, buildEventsFeed, buildStatus } from '../../src/adapters/http/ui-data.js';
import type { IssueStateRecord, RunRecord } from '../../src/domain/types.js';

function issueState(input: {
  number: number;
  stage: IssueStateRecord['wake']['stage'];
  sessionId?: string;
  lastRunId?: string;
  syncedAt?: string;
}): IssueStateRecord {
  const syncedAt = input.syncedAt ?? '2026-07-05T12:00:00.000Z';
  return {
    schemaVersion: 1,
    workItemKey: `atolis-hq/wake#${input.number}`,
    issue: {
      repo: 'atolis-hq/wake',
      number: input.number,
      title: 'Spec item',
      body: 'Body',
      labels: [],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: `https://example.test/issues/${input.number}`,
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: syncedAt,
    },
    comments: [],
    wake: {
      stage: input.stage,
      stageHistory: [{ stage: input.stage, changedAt: syncedAt, reason: 'test' }],
      recentEventIds: [],
      syncedAt,
      expectedEcho: { commentIds: [], labels: [] },
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.lastRunId === undefined ? {} : { lastRunId: input.lastRunId }),
    },
    context: {},
  };
}

function runRecord(input: {
  runId: string;
  issueNumber: number;
  status: RunRecord['status'];
  sentinel?: RunRecord['sentinel'];
  startedAt?: string;
  costUsd?: number;
}): RunRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    repo: 'atolis-hq/wake',
    issueNumber: input.issueNumber,
    action: 'implement',
    status: input.status,
    startedAt: input.startedAt ?? '2026-07-05T12:00:00.000Z',
    tokenUsage: input.costUsd === undefined
      ? undefined
      : { inputTokens: 1, outputTokens: 1, costUsd: input.costUsd },
    ...(input.sentinel === undefined ? {} : { sentinel: input.sentinel, finishedAt: '2026-07-05T12:05:00.000Z' }),
  };
}

describe('ui-data', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-ui-data-'));
  });

  it('derives board conditions from stage, routes, and run state', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeIssueState(issueState({ number: 1, stage: 'implement', lastRunId: 'run-1' }));
    await store.writeIssueState(issueState({ number: 2, stage: 'implement', lastRunId: 'run-2' }));
    await store.writeIssueState(issueState({ number: 3, stage: 'done' }));
    await store.writeIssueState(issueState({ number: 4, stage: 'queue' }));
    await store.writeRunRecord(runRecord({ runId: 'run-1', issueNumber: 1, status: 'running' }));
    await store.writeRunRecord(runRecord({
      runId: 'run-2',
      issueNumber: 2,
      status: 'blocked',
      sentinel: 'BLOCKED',
    }));

    const board = await buildBoard({ stateStore: store, config, now: new Date('2026-07-05T13:00:00.000Z') });
    const byNumber = new Map(board.map((card) => [card.number, card]));

    expect(byNumber.get(1)?.condition).toBe('active');
    expect(byNumber.get(2)?.condition).toBe('needs-human');
    expect(byNumber.get(3)?.condition).toBe('finished');
    expect(byNumber.get(4)?.condition).toBe('ready');
  });

  it('flags a stage with no configured route as stalled', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeIssueState(issueState({ number: 9, stage: 'implement', lastRunId: 'run-9' }));
    await store.writeRunRecord(runRecord({
      runId: 'run-9',
      issueNumber: 9,
      status: 'awaiting-approval',
      sentinel: 'AWAITING_APPROVAL',
    }));
    // Use a stage with no route to hit stalled.
    await store.writeIssueState(
      issueState({ number: 10, stage: 'refine' }),
    );

    const board = await buildBoard({ stateStore: store, config, now: new Date() });
    const byNumber = new Map(board.map((card) => [card.number, card]));

    expect(byNumber.get(9)?.condition).toBe('needs-human');
    expect(byNumber.get(10)?.condition).toBe('stalled');
  });

  it('reports idle loop state when no lock is held and nothing is paused', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    const status = await buildStatus({ stateStore: store, config, now: new Date() });

    expect(status.loopState).toBe('idle');
    expect(status.paused).toBe(false);
    expect(status.counters.finished).toBe(0);
  });

  it('builds status from recent events and today run buckets without a full history run scan', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord(runRecord({
      runId: 'run-yesterday',
      issueNumber: 1,
      status: 'completed',
      startedAt: '2026-07-04T23:59:00.000Z',
      costUsd: 10,
    }));
    await store.writeRunRecord(runRecord({
      runId: 'run-today',
      issueNumber: 2,
      status: 'failed',
      startedAt: '2026-07-05T01:00:00.000Z',
      costUsd: 2,
    }));
    await store.appendEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-latest',
      workItemKey: 'atolis-hq/wake#2',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 2 },
      occurredAt: '2026-07-05T01:00:00.000Z',
      ingestedAt: '2026-07-05T01:00:01.000Z',
      trigger: 'immediate',
      payload: {},
    });

    const status = await buildStatus({
      stateStore: store,
      config,
      now: new Date('2026-07-05T13:00:00.000Z'),
    });

    expect(status.runsToday).toBe(1);
    expect(status.failuresToday).toBe(1);
    expect(status.costUsdToday).toBe(2);
    expect(status.lastRun?.issueNumber).toBe(2);
    expect(status.lastEvent?.type).toBe('ticket.comment.created');
  });

  it('caps the events feed using the recent event store helper', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.appendEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-one',
      workItemKey: 'atolis-hq/wake#1',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 1 },
      occurredAt: '2026-07-05T01:00:00.000Z',
      ingestedAt: '2026-07-05T01:00:00.000Z',
      trigger: 'immediate',
      payload: {},
    });
    await store.appendEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-two',
      workItemKey: 'atolis-hq/wake#1',
      streamScope: 'work-item',
      direction: 'inbound',
      sourceSystem: 'github',
      sourceEventType: 'ticket.comment.created',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 1 },
      occurredAt: '2026-07-05T01:00:01.000Z',
      ingestedAt: '2026-07-05T01:00:01.000Z',
      trigger: 'immediate',
      payload: {},
    });

    const events = await buildEventsFeed({ stateStore: store, limit: 1 });

    expect(config.ui.archiveFreshnessDays).toBe(5);
    expect(events.map((event) => event.eventId)).toEqual(['evt-two']);
  });

  it('marks a paused tier candidate in the routing table fallback order (#67)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.runners['fake-primary'] = { kind: 'fake', cli: 'Fake Primary' };
    config.runners['fake-secondary'] = { kind: 'fake', cli: 'Fake Secondary' };
    config.tiers.standard = ['fake-primary', 'fake-secondary'];
    config.stages.implement = { action: 'implement', tier: 'standard' };

    await store.writeLedger({
      schemaVersion: 1,
      runners: {
        'fake-primary': { pausedUntil: '2026-07-08T01:00:00.000Z', failureCount: 1 },
      },
    });

    const view = await buildConfigView({
      stateStore: store,
      config,
      now: new Date('2026-07-07T22:00:00.000Z'),
    });
    const implementRoute = view.routingTable.find((r) => r.stage === 'implement');

    expect(implementRoute?.candidates).toEqual([
      { runnerName: 'fake-primary', paused: true, pausedUntil: '2026-07-08T01:00:00.000Z' },
      { runnerName: 'fake-secondary', paused: false, pausedUntil: undefined },
    ]);
  });
});
