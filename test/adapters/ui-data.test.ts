import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { acquireFileLock } from '../../src/lib/lock.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import {
  buildBoard,
  buildConfigView,
  buildEventsFeed,
  buildItemDetail,
  buildItemTranscripts,
  buildMetrics,
  buildStatus,
} from '../../src/adapters/http/ui-data.js';
import { createWakePaths } from '../../src/lib/paths.js';
import type { IssueStateRecord, RunRecord } from '../../src/domain/types.js';
import type { WorkItemStatus } from '../../src/domain/work-item-status.js';

/** A stable, ULID-shaped work id per issue number; real ids come from createWorkId(). */
function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

function issueState(input: {
  number: number;
  stage: IssueStateRecord['wake']['stage'];
  sessionId?: string;
  lastRunId?: string;
  syncedAt?: string;
  frozenAt?: string;
  status?: WorkItemStatus;
}): IssueStateRecord {
  const syncedAt = input.syncedAt ?? '2026-07-05T12:00:00.000Z';
  return {
    schemaVersion: 1,
    workItemKey: workId(input.number),
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
    context: {
      ...(input.frozenAt === undefined ? {} : { frozen: { at: input.frozenAt, by: 'test' } }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    correlatedResources: [],
  };
}

function runRecord(input: {
  runId: string;
  issueNumber: number;
  status: RunRecord['status'];
  action?: string;
  sentinel?: RunRecord['sentinel'];
  startedAt?: string;
  costUsd?: number;
  sessionId?: string;
  routing?: RunRecord['routing'];
}): RunRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    workItemKey: workId(input.issueNumber),
    repo: 'atolis-hq/wake',
    issueNumber: input.issueNumber,
    action: input.action ?? 'implement',
    lifecycle: input.status === 'running' ? 'RUNNING' : 'TERMINAL',
    status: input.status,
    startedAt: input.startedAt ?? '2026-07-05T12:00:00.000Z',
    tokenUsage:
      input.costUsd === undefined
        ? undefined
        : { inputTokens: 1, outputTokens: 1, costUsd: input.costUsd },
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.routing === undefined ? {} : { routing: input.routing }),
    ...(input.sentinel === undefined
      ? {}
      : { sentinel: input.sentinel, finishedAt: '2026-07-05T12:05:00.000Z' }),
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

    await store.writeIssueState(
      issueState({ number: 1, stage: 'implement', lastRunId: 'run-1', status: 'working' }),
    );
    await store.writeIssueState(
      issueState({ number: 2, stage: 'implement', lastRunId: 'run-2', status: 'blocked' }),
    );
    await store.writeIssueState(issueState({ number: 3, stage: 'done', status: 'done' }));
    await store.writeIssueState(issueState({ number: 4, stage: 'queue' }));
    await store.writeIssueState(
      issueState({ number: 5, stage: 'implement', lastRunId: 'run-5', status: 'queued' }),
    );
    await store.writeRunRecord(runRecord({ runId: 'run-1', issueNumber: 1, status: 'running' }));
    await store.writeRunRecord(
      runRecord({
        runId: 'run-2',
        issueNumber: 2,
        status: 'blocked',
        sentinel: 'BLOCKED',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-5',
        issueNumber: 5,
        status: 'completed',
        sentinel: 'DONE',
      }),
    );

    const board = await buildBoard({
      stateStore: store,
      config,
      now: new Date('2026-07-05T13:00:00.000Z'),
    });

    const byNumber = new Map(board.map((card) => [card.number, card]));

    expect(byNumber.get(1)?.condition).toBe('active');
    expect(byNumber.get(1)?.workItemKey).toBe(workId(1));
    expect(byNumber.get(1)?.displayStatus).toBe('working');
    expect(byNumber.get(2)?.condition).toBe('needs-human');
    expect(byNumber.get(2)?.displayStatus).toBe('blocked');
    expect(byNumber.get(3)?.condition).toBe('finished');
    expect(byNumber.get(3)?.displayStatus).toBe('done');
    expect(byNumber.get(4)?.condition).toBe('ready');
    expect(byNumber.get(4)?.displayStatus).toBe('queued');
    expect(byNumber.get(5)?.condition).toBe('ready');
    expect(byNumber.get(5)?.displayStatus).toBe('queued');
  });

  it('marks frozen board cards explicitly', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeIssueState(
      issueState({
        number: 6,
        stage: 'implement',
        frozenAt: '2026-07-05T12:30:00.000Z',
      }),
    );

    const board = await buildBoard({
      stateStore: store,
      config,
      now: new Date('2026-07-05T13:00:00.000Z'),
    });

    expect(board.find((item) => item.number === 6)).toMatchObject({
      condition: 'needs-human',
      conditionReason: 'work item frozen',
      isFrozen: true,
    });
  });

  it('surfaces running watcher runs as child rows without replacing the projection last run', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeIssueState(
      issueState({ number: 5, stage: 'implement', lastRunId: 'run-5-implement' }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-5-implement',
        issueNumber: 5,
        status: 'awaiting-approval',
        sentinel: 'AWAITING_APPROVAL',
        startedAt: '2026-07-05T12:00:00.000Z',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-5-review',
        issueNumber: 5,
        action: 'pr-review',
        status: 'running',
        startedAt: '2026-07-05T12:10:00.000Z',
        routing: {
          runnerName: 'codex-standard',
          runnerKind: 'codex',
          tier: 'light',
          reason: 'test',
        },
      }),
    );

    const board = await buildBoard({
      stateStore: store,
      config,
      now: new Date('2026-07-05T13:00:00.000Z'),
    });

    const card = board.find((item) => item.number === 5);
    expect(card).toMatchObject({
      condition: 'needs-human',
      lastRunAction: 'implement',
      lastRunSentinel: 'AWAITING_APPROVAL',
      activeChildRuns: [
        {
          runId: 'run-5-review',
          action: 'pr-review',
          status: 'running',
          runnerName: 'codex-standard',
          runnerKind: 'codex',
          tier: 'light',
          startedAt: '2026-07-05T12:10:00.000Z',
          ageMs: 3_000_000,
        },
      ],
    });
  });

  it('includes per-run averages for grouped token metrics', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.runners['codex-main'] = {
      kind: 'codex',
      command: 'codex',
      model: 'gpt-5.5',
      smokeModel: 'gpt-5.4-mini',
      smokePrompt: 'hi',
      timeoutMs: 1000,
    };

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-token-one',
        issueNumber: 83,
        status: 'completed',
        startedAt: '2026-07-25T08:00:00.000Z',
      }),
      routing: {
        runnerName: 'codex-main',
        runnerKind: 'codex',
        tier: 'standard',
        reason: 'test',
      },
      tokenUsage: { inputTokens: 100, outputTokens: 50, costUsd: 1.5 },
    });
    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-token-two',
        issueNumber: 84,
        status: 'completed',
        startedAt: '2026-07-25T09:00:00.000Z',
      }),
      routing: {
        runnerName: 'codex-main',
        runnerKind: 'codex',
        tier: 'standard',
        reason: 'test',
      },
      tokenUsage: { inputTokens: 50, outputTokens: 20, costUsd: 0.5 },
    });

    const metrics = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'tokens-by-model',
    });

    expect(metrics.detail).toEqual({
      kind: 'token-counts',
      group: 'model',
      rows: [
        {
          key: 'gpt-5.5',
          count: 2,
          tokens: 220,
          averageTokens: 110,
          costUsd: 2,
          averageCostUsd: 1,
        },
      ],
    });
  });

  it('includes total duration for grouped and over-time duration metrics', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-duration-one',
        issueNumber: 85,
        status: 'completed',
        startedAt: '2026-07-25T08:00:00.000Z',
      }),
      finishedAt: '2026-07-25T08:10:00.000Z',
      action: 'implement',
    });
    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-duration-two',
        issueNumber: 86,
        status: 'completed',
        startedAt: '2026-07-25T08:30:00.000Z',
      }),
      finishedAt: '2026-07-25T08:50:00.000Z',
      action: 'implement',
    });

    const byAction = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'duration-by-action',
    });
    expect(byAction.detail).toEqual({
      kind: 'durations',
      group: 'action',
      rows: [
        {
          key: 'implement',
          count: 2,
          totalMs: 1800000,
          averageMs: 900000,
          medianMs: 900000,
        },
      ],
    });

    const overTime = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'duration-over-time',
    });
    expect(overTime.detail.kind).toBe('duration-over-time');
    if (overTime.detail.kind !== 'duration-over-time') {
      throw new Error(`unexpected detail kind: ${overTime.detail.kind}`);
    }
    expect(overTime.detail.rows.find((row) => row.bucket === '2026-07-25T08')).toMatchObject({
      label: '08:00',
      count: 2,
      totalMs: 1800000,
      averageMs: 900000,
      medianMs: 900000,
    });
  });

  // The UI addresses items by the ticket a human recognizes (work ids are
  // opaque, spec D3), but that must not cost a full projection scan per view.
  // The route constructs the ticket's uri and resolves it through the index
  // (spec D2), then keys everything downstream off the record's own work id.
  it('resolves an item detail through the resource index without scanning every projection', async () => {
    const store = createStateStore({ wakeRoot: root });
    let listIssueStatesCalls = 0;
    const countingStore = {
      ...store,
      async listIssueStates(...args: Parameters<typeof store.listIssueStates>) {
        listIssueStatesCalls += 1;
        return store.listIssueStates(...args);
      },
    };

    await store.writeIssueState(issueState({ number: 7, stage: 'implement', lastRunId: 'run-7' }));
    await store.writeIssueState(issueState({ number: 8, stage: 'queue' }));
    await store.writeRunRecord(runRecord({ runId: 'run-7', issueNumber: 7, status: 'running' }));

    const resourceIndex = createFakeResourceIndex();
    await resourceIndex.register('github:issue:atolis-hq/wake#7', workId(7));

    const detail = await buildItemDetail({
      stateStore: countingStore,
      resourceIndex,
      provider: 'github',
      repo: 'atolis-hq/wake',
      issueNumber: 7,
    });

    expect(detail?.item.workItemKey).toBe(workId(7));
    expect(detail?.runs.map((run) => run.runId)).toEqual(['run-7']);
    expect(listIssueStatesCalls).toBe(0);

    // A ticket with no index entry is simply not found — never a scan.
    const missing = await buildItemDetail({
      stateStore: countingStore,
      resourceIndex,
      provider: 'github',
      repo: 'atolis-hq/wake',
      issueNumber: 404,
    });
    expect(missing).toBeNull();
    expect(listIssueStatesCalls).toBe(0);
  });

  it('resolves an item detail directly by work item key', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState({ number: 9, stage: 'implement', lastRunId: 'run-9' }));
    await store.writeRunRecord(runRecord({ runId: 'run-9', issueNumber: 9, status: 'running' }));

    const detail = await buildItemDetail({
      stateStore: store,
      workItemKey: workId(9),
    });

    expect(detail?.item.workItemKey).toBe(workId(9));
    expect(detail?.runs.map((run) => run.runId)).toEqual(['run-9']);

    const missing = await buildItemDetail({
      stateStore: store,
      workItemKey: workId(404),
    });
    expect(missing).toBeNull();
  });

  it('flags a stage with no configured route as error', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeIssueState(issueState({ number: 9, stage: 'implement', lastRunId: 'run-9' }));
    await store.writeRunRecord(
      runRecord({
        runId: 'run-9',
        issueNumber: 9,
        status: 'awaiting-approval',
        sentinel: 'AWAITING_APPROVAL',
      }),
    );
    // Use a stage with no route to hit error (no configured route).
    await store.writeIssueState(issueState({ number: 10, stage: 'unknown-stage' }));

    const board = await buildBoard({ stateStore: store, config, now: new Date() });
    const byNumber = new Map(board.map((card) => [card.number, card]));

    expect(byNumber.get(9)?.condition).toBe('needs-human');
    expect(byNumber.get(10)?.condition).toBe('error');
  });

  it('reports idle loop state when no lock is held and nothing is paused', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    const status = await buildStatus({ stateStore: store, config, now: new Date() });

    expect(status.loopState).toBe('idle');
    expect(status.paused).toBe(false);
    expect(status.counters.finished).toBe(0);
  });

  it('reports paused loop state when the manual pause file is present', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await mkdir(join(root, '.wake'), { recursive: true });
    await writeFile(store.paths.pauseFile, '2026-07-26T11:42:30.000Z\n', 'utf8');

    const status = await buildStatus({ stateStore: store, config, now: new Date() });

    expect(status.loopState).toBe('paused');
    expect(status.paused).toBe(true);
  });

  it('reports polling loop state while only the intake tick lock is held', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    const lock = await acquireFileLock(store.paths.tickLockFile);
    const status = await buildStatus({ stateStore: store, config, now: new Date() });
    await lock.release();

    expect(status.loopState).toBe('polling');
  });

  it('reports working loop state while an agent run holds the runner lock, even if the tick lock is free', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    const lock = await acquireFileLock(store.paths.runnerLockFile);
    const status = await buildStatus({ stateStore: store, config, now: new Date() });
    await lock.release();

    expect(status.loopState).toBe('working');
  });

  it('does not report working when a stale runner lock PID was reused by another command', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await mkdir(join(root, '.wake', 'locks'), { recursive: true });
    await writeFile(
      store.paths.runnerLockFile,
      `${JSON.stringify({
        pid: 24,
        acquiredAt: '2026-07-05T12:00:00.000Z',
        lockId: 'stale-runner-lock',
        commandLine: 'node /app/dist/src/main.js start --wake-root /wake',
      })}\n`,
      'utf8',
    );

    const status = await buildStatus({
      stateStore: store,
      config,
      now: new Date('2026-07-05T12:00:01.000Z'),
      processInspector: {
        isPidAlive: () => true,
        readCommandLine: () => 'ngrok http 127.0.0.1:4317 --log=stdout',
      },
    });

    expect(status.loopState).toBe('idle');
    expect(status.runnerLock.pidAlive).toBe(false);
    expect(status.runnerLock.staleReason).toBe('pid-command-mismatch');
  });

  it('builds status from recent events and today run buckets without a full history run scan', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord(
      runRecord({
        runId: 'run-yesterday',
        issueNumber: 1,
        status: 'completed',
        startedAt: '2026-07-04T23:59:00.000Z',
        costUsd: 10,
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-today',
        issueNumber: 2,
        status: 'failed',
        startedAt: '2026-07-05T01:00:00.000Z',
        costUsd: 2,
      }),
    );
    await store.appendEventEnvelope({
      schemaVersion: 1,
      eventId: 'evt-latest',
      workItemKey: workId(2),
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
      workItemKey: workId(1),
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
      workItemKey: workId(1),
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
    config.workflows.default!.stages.implement!.tier = 'standard';

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

    expect(implementRoute?.workflow).toBe('default');
    expect(implementRoute?.candidates).toEqual([
      { runnerName: 'fake-primary', paused: true, pausedUntil: '2026-07-08T01:00:00.000Z' },
      { runnerName: 'fake-secondary', paused: false, pausedUntil: undefined },
    ]);
  });

  it('groups item transcripts by session and orders entries by run start with prompts first', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.transcripts.enabled = true;
    const paths = createWakePaths(root);

    await store.writeIssueState(issueState({ number: 320, stage: 'implement' }));
    await store.writeRunRecord(
      runRecord({
        runId: 'run-later',
        issueNumber: 320,
        status: 'completed',
        startedAt: '2026-07-05T12:10:00.000Z',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-earlier',
        issueNumber: 320,
        status: 'completed',
        startedAt: '2026-07-05T12:00:00.000Z',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-next-session',
        issueNumber: 320,
        status: 'completed',
        startedAt: '2026-07-05T13:00:00.000Z',
      }),
    );

    const firstSession = paths.transcriptSessionDir(workId(320), 'session-one');
    const secondSession = paths.transcriptSessionDir(workId(320), 'session-two');
    await mkdir(firstSession, { recursive: true });
    await mkdir(secondSession, { recursive: true });
    await writeFile(join(firstSession, 'run-later.codex.implement.response.txt'), 'later response');
    await writeFile(
      join(firstSession, 'run-earlier.codex.implement.response.txt'),
      'early response',
    );
    await writeFile(join(firstSession, 'run-earlier.codex.implement.prompt.txt'), 'early prompt');
    await writeFile(
      join(secondSession, 'run-next-session.cursor.review.prompt.txt'),
      'next prompt',
    );

    const transcripts = await buildItemTranscripts({
      stateStore: store,
      config,
      workItemKey: workId(320),
    });

    expect(transcripts.enabled).toBe(true);
    expect(transcripts.sessions.map((session) => session.sessionKey)).toEqual([
      'session-one',
      'session-two',
    ]);
    expect(transcripts.sessions[0]?.entries.map((entry) => [entry.runId, entry.role])).toEqual([
      ['run-earlier', 'user'],
      ['run-earlier', 'agent'],
      ['run-later', 'agent'],
    ]);
    expect(transcripts.sessions[0]?.entries[0]).toMatchObject({
      action: 'implement',
      cli: 'codex',
      startedAt: '2026-07-05T12:00:00.000Z',
      text: 'early prompt',
    });
  });

  it('groups transcript directories by the actual CLI session id when run records have one', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.transcripts.enabled = true;
    const paths = createWakePaths(root);

    await store.writeIssueState(issueState({ number: 323, stage: 'implement' }));
    await store.writeRunRecord(
      runRecord({
        runId: 'run-initial',
        issueNumber: 323,
        status: 'blocked',
        startedAt: '2026-07-05T12:00:00.000Z',
        sessionId: 'cli-session-323',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-resume',
        issueNumber: 323,
        status: 'completed',
        startedAt: '2026-07-05T12:30:00.000Z',
        sessionId: 'cli-session-323',
      }),
    );

    const initialRunDir = paths.transcriptSessionDir(workId(323), 'run-initial');
    const resumedSessionDir = paths.transcriptSessionDir(workId(323), 'cli-session-323');
    await mkdir(initialRunDir, { recursive: true });
    await mkdir(resumedSessionDir, { recursive: true });
    await writeFile(join(initialRunDir, 'run-initial.codex.implement.response.txt'), 'blocked');
    await writeFile(join(resumedSessionDir, 'run-resume.codex.implement.prompt.txt'), 'resume');

    const transcripts = await buildItemTranscripts({
      stateStore: store,
      config,
      workItemKey: workId(323),
    });

    expect(transcripts.sessions).toHaveLength(1);
    expect(transcripts.sessions[0]).toMatchObject({
      sessionKey: 'cli-session-323',
      sessionId: 'cli-session-323',
    });
    expect(transcripts.sessions[0]?.entries.map((entry) => entry.runId)).toEqual([
      'run-initial',
      'run-resume',
    ]);
  });

  it('returns disabled transcript payload without reading transcript files', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeIssueState(issueState({ number: 321, stage: 'implement' }));
    await mkdir(createWakePaths(root).transcriptSessionDir(workId(321), 'session'), {
      recursive: true,
    });

    const transcripts = await buildItemTranscripts({
      stateStore: store,
      config,
      workItemKey: workId(321),
    });

    expect(transcripts).toEqual({ enabled: false, sessions: [] });
  });

  it('returns an enabled empty transcript payload when no transcript files exist', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.transcripts.enabled = true;

    await store.writeIssueState(issueState({ number: 322, stage: 'implement' }));

    const transcripts = await buildItemTranscripts({
      stateStore: store,
      config,
      workItemKey: workId(322),
    });

    expect(transcripts).toEqual({ enabled: true, sessions: [] });
  });

  it('returns a shared summary and only the selected runs-over-time detail', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-completed',
        issueNumber: 71,
        status: 'completed',
        startedAt: '2026-07-24T10:00:00.000Z',
      }),
      finishedAt: '2026-07-24T10:10:00.000Z',
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 5,
        costUsd: 2.5,
      },
    });
    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-failed',
        issueNumber: 72,
        status: 'failed',
        startedAt: '2026-07-25T09:00:00.000Z',
      }),
      finishedAt: '2026-07-25T09:01:00.000Z',
      tokenUsage: { inputTokens: 20, outputTokens: 10, costUsd: 0.25 },
    });

    const metrics = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '7d',
      metric: 'runs-over-time',
    });

    expect(metrics.window).toBe('7d');
    expect(metrics.metric).toBe('runs-over-time');
    expect(metrics.summary).toMatchObject({
      totalRuns: 2,
      completedRuns: 1,
      failedRuns: 1,
      totalTokens: 170,
      totalCostUsd: 2.75,
      medianRunDurationMs: 330000,
    });
    expect(metrics.detail.kind).toBe('runs-over-time');
    expect(metrics.detail.rows).toHaveLength(7);
    expect(metrics.detail.rows.at(-2)).toMatchObject({
      bucket: '2026-07-24',
      label: 'Jul 24',
      total: 1,
      completed: 1,
    });
    expect(metrics.detail.rows.at(-1)).toMatchObject({
      bucket: '2026-07-25',
      label: 'Jul 25',
      total: 1,
      failed: 1,
    });
  });

  it('returns runs by status over time as its own selectable metric', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord(
      runRecord({
        runId: 'run-status-completed',
        issueNumber: 72,
        status: 'completed',
        startedAt: '2026-07-25T09:15:00.000Z',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-status-blocked',
        issueNumber: 73,
        status: 'blocked',
        sentinel: 'BLOCKED',
        startedAt: '2026-07-25T09:45:00.000Z',
      }),
    );

    const metrics = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-by-status-over-time',
    });

    expect(metrics.metric).toBe('runs-by-status-over-time');
    expect(metrics.detail.kind).toBe('runs-by-status-over-time');
    if (metrics.detail.kind !== 'runs-by-status-over-time') {
      throw new Error(`unexpected detail kind: ${metrics.detail.kind}`);
    }
    expect(metrics.detail.rows.find((row) => row.bucket === '2026-07-25T09')).toMatchObject({
      label: '09:00',
      total: 2,
      completed: 1,
      blocked: 1,
      awaitingApproval: 0,
      failed: 0,
      other: 0,
    });
  });

  it('loads metrics runs from date buckets instead of scanning the full run history', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    const countingStore = {
      ...store,
      async listRunRecords() {
        throw new Error('full run scan should not be used for metrics');
      },
      async listRunRecordsForDate(...args: Parameters<typeof store.listRunRecordsForDate>) {
        return store.listRunRecordsForDate(...args);
      },
    };

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-bucketed',
        issueNumber: 82,
        status: 'completed',
        startedAt: '2026-07-25T10:00:00.000Z',
      }),
      finishedAt: '2026-07-25T10:01:00.000Z',
    });

    const metrics = await buildMetrics({
      stateStore: countingStore,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-by-status',
    });

    expect(metrics.detail).toEqual({
      kind: 'run-counts',
      group: 'status',
      rows: [{ key: 'completed', count: 1 }],
    });
  });

  it('uses hourly buckets for 1d and 6-hour buckets for 3d', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-hourly',
        issueNumber: 73,
        status: 'completed',
        startedAt: '2026-07-25T09:15:00.000Z',
      }),
      finishedAt: '2026-07-25T09:45:00.000Z',
    });

    const oneDay = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-over-time',
    });
    expect(oneDay.detail.kind).toBe('runs-over-time');
    if (oneDay.detail.kind !== 'runs-over-time') {
      throw new Error(`unexpected detail kind: ${oneDay.detail.kind}`);
    }
    expect(oneDay.detail.rows).toHaveLength(24);
    expect(oneDay.detail.rows.find((row) => row.bucket === '2026-07-25T09')).toMatchObject({
      label: '09:00',
      total: 1,
    });

    const threeDay = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '3d',
      metric: 'runs-over-time',
    });
    expect(threeDay.detail.kind).toBe('runs-over-time');
    if (threeDay.detail.kind !== 'runs-over-time') {
      throw new Error(`unexpected detail kind: ${threeDay.detail.kind}`);
    }
    expect(threeDay.detail.rows).toHaveLength(12);
    expect(threeDay.detail.rows.find((row) => row.bucket === '2026-07-25T06')).toMatchObject({
      label: 'Jul 25 06:00',
      total: 1,
    });
  });

  it('groups only the selected runner metric and resolves models from config when requested', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.runners['codex-main'] = {
      kind: 'codex',
      command: 'codex',
      model: 'gpt-5.5',
      smokeModel: 'gpt-5.4-mini',
      smokePrompt: 'hi',
      timeoutMs: 1000,
    };

    await store.writeRunRecord({
      ...runRecord({
        runId: 'run-known',
        issueNumber: 74,
        status: 'completed',
        startedAt: '2026-07-25T08:00:00.000Z',
      }),
      routing: {
        runnerName: 'codex-main',
        runnerKind: 'codex',
        tier: 'standard',
        reason: 'test',
      },
    });
    await store.writeRunRecord(
      runRecord({
        runId: 'run-unknown',
        issueNumber: 75,
        status: 'completed',
        startedAt: '2026-07-25T09:00:00.000Z',
      }),
    );

    const byRunner = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-by-runner',
    });
    expect(byRunner.detail).toEqual({
      kind: 'run-counts',
      group: 'runner',
      rows: [
        { key: 'codex-main', count: 1 },
        { key: 'unknown', count: 1 },
      ],
    });

    const byModel = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'runs-by-model',
    });
    expect(byModel.detail).toEqual({
      kind: 'run-counts',
      group: 'model',
      rows: [
        { key: 'gpt-5.5', count: 1 },
        { key: 'unknown', count: 1 },
      ],
    });
  });

  it('computes completed work-item e2e duration only for selected work-item detail metrics', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    const base = issueState({ number: 81, stage: 'done' });

    await store.writeIssueState({
      ...base,
      issue: {
        ...base.issue,
        createdAt: '2026-07-25T09:00:00.000Z',
        updatedAt: '2026-07-25T11:00:00.000Z',
      },
      wake: {
        ...base.wake,
        syncedAt: '2026-07-25T11:00:00.000Z',
        stageHistory: [
          { stage: 'queue', changedAt: '2026-07-25T09:00:00.000Z', reason: 'test' },
          { stage: 'done', changedAt: '2026-07-25T11:00:00.000Z', reason: 'test' },
        ],
      },
    });

    const metrics = await buildMetrics({
      stateStore: store,
      config,
      now: new Date('2026-07-25T12:00:00.000Z'),
      window: '1d',
      metric: 'work-item-durations',
    });

    expect(metrics.summary.completedWorkItems).toBe(1);
    expect(metrics.summary.medianWorkItemDurationMs).toBe(7200000);
    expect(metrics.detail).toEqual({
      kind: 'work-item-durations',
      rows: [
        {
          key: workId(81),
          repo: 'atolis-hq/wake',
          issueNumber: 81,
          durationMs: 7200000,
          completedAt: '2026-07-25T11:00:00.000Z',
        },
      ],
    });
  });
});
