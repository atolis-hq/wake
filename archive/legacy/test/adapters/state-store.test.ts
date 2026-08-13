import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import type { EventEnvelope, IssueStateRecord, RunRecord } from '../../src/domain/types.js';
import { createWakePaths } from '../../src/lib/paths.js';
import { StateHealthError } from '../../src/lib/state-health.js';

/**
 * A stable, ULID-shaped work id per issue number, so a fixture can name the
 * key it expects without minting. Real ids come from createWorkId().
 */
function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

function issueState(input?: {
  recentEventIds?: string[];
  workItemKey?: string;
  number?: number;
  stage?: IssueStateRecord['wake']['stage'];
  issueState?: IssueStateRecord['issue']['state'];
  syncedAt?: string;
}): IssueStateRecord {
  const number = input?.number ?? 7;
  const syncedAt = input?.syncedAt ?? '2026-07-05T12:00:00.000Z';

  return {
    schemaVersion: 1,
    workItemKey: input?.workItemKey ?? workId(number),
    origin: 'github',
    issue: {
      repo: 'atolis-hq/wake',
      number,
      title: 'Spec',
      body: 'Body',
      labels: ['wake:queue'],
      assignees: [],
      isPullRequest: false,
      state: input?.issueState ?? 'open',
      url: `https://example.test/issues/${number}`,
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: syncedAt,
    },
    comments: [],
    wake: {
      stage: input?.stage ?? 'queue',
      stageHistory: [{ stage: input?.stage ?? 'queue', changedAt: syncedAt, reason: 'test' }],
      recentEventIds: input?.recentEventIds ?? [],
      syncedAt,
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {},
    correlatedResources: [],
  };
}

function runRecord(input: {
  runId: string;
  issueNumber?: number;
  startedAt: string;
  status?: RunRecord['status'];
  metadata?: Record<string, unknown>;
  runtimeEvents?: RunRecord['runtimeEvents'];
}): RunRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    workItemKey: workId(input.issueNumber ?? 7),
    repo: 'atolis-hq/wake',
    issueNumber: input.issueNumber ?? 7,
    action: 'implement',
    lifecycle: input.status === 'running' ? 'RUNNING' : 'TERMINAL',
    status: input.status ?? 'completed',
    startedAt: input.startedAt,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    ...(input.runtimeEvents === undefined ? {} : { runtimeEvents: input.runtimeEvents }),
  };
}

function eventEnvelope(input: {
  eventId: string;
  occurredAt?: string;
  ingestedAt?: string;
  workItemKey?: string;
}): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    workItemKey: input.workItemKey ?? workId(7),
    streamScope: 'work-item',
    direction: 'inbound',
    sourceSystem: 'github',
    sourceEventType: 'ticket.comment.created',
    sourceRefs: {
      repo: 'atolis-hq/wake',
      issueNumber: 7,
      commentId: input.eventId,
    },
    occurredAt: input.occurredAt ?? '2026-07-05T12:00:00.000Z',
    ingestedAt: input.ingestedAt ?? '2026-07-05T12:00:01.000Z',
    trigger: 'immediate',
    payload: {
      comment: {
        id: input.eventId,
        body: 'Body',
        author: { login: 'human' },
        createdAt: input.occurredAt ?? '2026-07-05T12:00:00.000Z',
        updatedAt: input.occurredAt ?? '2026-07-05T12:00:00.000Z',
      },
    },
  };
}

function runSummaryIndexFile(root: string, date: string): string {
  return join(root, '.wake', 'runs', 'by-date', date, 'index.json');
}

describe('state store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-state-store-'));
  });

  it('writes and reads issue state records at a flat state/<workId>.json', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.writeIssueState(issueState());

    // No provider, repo, or issue segment anywhere in the path (spec §3).
    await expect(readFile(paths.workItemStateFile(workId(7)), 'utf8')).resolves.toContain('Spec');

    const saved = await store.readIssueState(workId(7));
    expect(saved?.issue.number).toBe(7);
  });

  it('buckets event log files by ingestedAt', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-stale-upstream',
        occurredAt: '2026-06-01T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:01.000Z',
      }),
    );

    await expect(readFile(paths.eventFile('2026-06-01'), 'utf8')).rejects.toThrow();
    expect(await readFile(paths.eventFile('2026-07-05'), 'utf8')).toContain('evt-stale-upstream');
  });

  it('does not append an event whose id is already persisted', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);
    const event = eventEnvelope({ eventId: 'evt-once' });

    await store.appendEventEnvelope(event);
    await store.appendEventEnvelope(event);

    const lines = (await readFile(paths.eventFile('2026-07-05'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('writes run records into date buckets while preserving id reads and full listing', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.writeRunRecord(
      runRecord({
        runId: 'run-old',
        startedAt: '2026-07-04T12:00:00.000Z',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-today',
        startedAt: '2026-07-05T12:00:00.000Z',
        status: 'failed',
      }),
    );

    await expect(readFile(paths.runDateFile('2026-07-05', 'run-today'), 'utf8')).resolves.toContain(
      'run-today',
    );
    await expect(store.readRunRecord('run-today')).resolves.toMatchObject({ status: 'failed' });
    await expect(store.listRunRecordsForDate('2026-07-05')).resolves.toHaveLength(1);
    await expect(store.listRunRecords()).resolves.toHaveLength(2);
  });

  it('strips captured stdout/stderr/raw and runtimeEvents from bulk run-record summaries only', async () => {
    const store = createStateStore({ wakeRoot: root });
    const heavyRunId = 'run-heavy';

    await store.writeRunRecord(
      runRecord({
        runId: heavyRunId,
        startedAt: '2026-07-05T12:00:00.000Z',
        metadata: {
          workspacePath: '/wake/.wake/repos/atolis-hq__wake',
          stdout: 'x'.repeat(1000),
          stderr: 'y'.repeat(1000),
          raw: { events: ['z'.repeat(1000)] },
        },
        runtimeEvents: [
          {
            type: 'agent.process.started',
            runId: heavyRunId,
            workItemId: workId(7),
            runner: { name: 'codex-standard', kind: 'codex', cli: 'Codex' },
            timestamp: '2026-07-05T12:00:00.000Z',
            sequence: 0,
            payload: {},
          },
        ],
      }),
    );

    // Full reads (single-run and unsummarized listings) keep everything -
    // reconciliation code spreads a listed record's metadata back into a
    // rewrite, so stripping here would silently drop captured output on disk.
    await expect(store.readRunRecord(heavyRunId)).resolves.toMatchObject({
      metadata: { stdout: 'x'.repeat(1000), stderr: 'y'.repeat(1000) },
      runtimeEvents: [expect.objectContaining({ type: 'agent.process.started' })],
    });
    const fullListed = await store.listRunRecords();
    expect(fullListed).toHaveLength(1);
    expect(fullListed[0]?.metadata?.stdout).toBe('x'.repeat(1000));
    expect(fullListed[0]?.runtimeEvents).toHaveLength(1);

    // Bulk summaries (board/runs/metrics UI) keep small metadata but drop the
    // captured-output fields and runtimeEvents.
    const summaryListed = await store.listRunRecordSummaries();
    expect(summaryListed).toHaveLength(1);
    expect(summaryListed[0]?.metadata).toEqual({
      workspacePath: '/wake/.wake/repos/atolis-hq__wake',
    });
    expect(summaryListed[0]?.runtimeEvents).toBeUndefined();

    const summaryForDate = await store.listRunRecordSummariesForDate('2026-07-05');
    expect(summaryForDate).toHaveLength(1);
    expect(summaryForDate[0]?.metadata).toEqual({
      workspacePath: '/wake/.wake/repos/atolis-hq__wake',
    });
    expect(summaryForDate[0]?.runtimeEvents).toBeUndefined();
  });

  it('writes a summarized run-record index entry for the run date', async () => {
    const store = createStateStore({ wakeRoot: root });
    const indexFile = runSummaryIndexFile(root, '2026-07-05');

    await store.writeRunRecord(
      runRecord({
        runId: 'run-indexed',
        startedAt: '2026-07-05T12:00:00.000Z',
        metadata: {
          workspacePath: '/wake/.wake/repos/atolis-hq__wake',
          stdout: 'captured stdout',
          stderr: 'captured stderr',
          raw: { transcript: 'raw transcript' },
        },
        runtimeEvents: [
          {
            type: 'agent.process.started',
            runId: 'run-indexed',
            workItemId: workId(7),
            runner: { name: 'codex-standard', kind: 'codex', cli: 'Codex' },
            timestamp: '2026-07-05T12:00:00.000Z',
            sequence: 0,
            payload: {},
          },
        ],
      }),
    );

    const index = JSON.parse(await readFile(indexFile, 'utf8')) as {
      schemaVersion: number;
      date: string;
      entries: RunRecord[];
    };
    expect(index.schemaVersion).toBe(1);
    expect(index.date).toBe('2026-07-05');
    expect(index.entries.map((entry) => entry.runId)).toEqual(['run-indexed']);
    expect(index.entries[0]?.metadata).toEqual({
      workspacePath: '/wake/.wake/repos/atolis-hq__wake',
    });
    expect(index.entries[0]?.runtimeEvents).toBeUndefined();
  });

  it('rebuilds a missing run-record summary index from date-bucket files', async () => {
    const store = createStateStore({ wakeRoot: root });
    const indexFile = runSummaryIndexFile(root, '2026-07-05');

    await store.writeRunRecord(
      runRecord({
        runId: 'run-rebuild',
        startedAt: '2026-07-05T12:00:00.000Z',
        metadata: { stdout: 'captured stdout' },
      }),
    );
    await rm(indexFile);

    const summaries = await store.listRunRecordSummariesForDate('2026-07-05');

    expect(summaries.map((record) => record.runId)).toEqual(['run-rebuild']);
    expect(summaries[0]?.metadata?.stdout).toBeUndefined();
    await expect(readFile(indexFile, 'utf8')).resolves.toContain('run-rebuild');
  });

  it('rebuilds a corrupt run-record summary index from date-bucket files', async () => {
    const store = createStateStore({ wakeRoot: root });
    const indexFile = runSummaryIndexFile(root, '2026-07-05');

    await store.writeRunRecord(
      runRecord({
        runId: 'run-corrupt-index',
        startedAt: '2026-07-05T12:00:00.000Z',
      }),
    );
    await writeFile(indexFile, '{not json\n', 'utf8');

    const summaries = await store.listRunRecordSummariesForDate('2026-07-05');

    expect(summaries.map((record) => record.runId)).toEqual(['run-corrupt-index']);
    await expect(readFile(indexFile, 'utf8')).resolves.toContain('run-corrupt-index');
  });

  it('rebuilds a stale run-record summary index whose entry count differs from date-bucket files', async () => {
    const store = createStateStore({ wakeRoot: root });
    const indexFile = runSummaryIndexFile(root, '2026-07-05');

    await store.writeRunRecord(
      runRecord({
        runId: 'run-stale-a',
        startedAt: '2026-07-05T12:00:00.000Z',
      }),
    );
    await store.writeRunRecord(
      runRecord({
        runId: 'run-stale-b',
        startedAt: '2026-07-05T12:01:00.000Z',
      }),
    );
    await writeFile(
      indexFile,
      JSON.stringify({
        schemaVersion: 1,
        date: '2026-07-05',
        entries: [
          runRecord({
            runId: 'run-stale-a',
            startedAt: '2026-07-05T12:00:00.000Z',
          }),
        ],
      }),
      'utf8',
    );

    const summaries = await store.listRunRecordSummariesForDate('2026-07-05');
    const rebuilt = JSON.parse(await readFile(indexFile, 'utf8')) as { entries: RunRecord[] };

    expect(summaries.map((record) => record.runId)).toEqual(['run-stale-a', 'run-stale-b']);
    expect(rebuilt.entries.map((record) => record.runId)).toEqual(['run-stale-a', 'run-stale-b']);
  });

  it('keeps legacy flat-only run-record date summaries working across repeated reads', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);
    const record = runRecord({
      runId: 'run-legacy-flat-only',
      startedAt: '2026-07-05T12:00:00.000Z',
      metadata: { stdout: 'captured stdout' },
    });
    await mkdir(join(paths.dataRoot, 'runs'), { recursive: true });
    await writeFile(paths.runFile(record.runId), JSON.stringify(record), 'utf8');

    const firstRead = await store.listRunRecordSummariesForDate('2026-07-05');
    const secondRead = await store.listRunRecordSummariesForDate('2026-07-05');

    expect(firstRead.map((entry) => entry.runId)).toEqual(['run-legacy-flat-only']);
    expect(secondRead.map((entry) => entry.runId)).toEqual(['run-legacy-flat-only']);
    expect(secondRead[0]?.metadata?.stdout).toBeUndefined();
  });

  it('preserves same-date run-record summary index entries across concurrent writes', async () => {
    const store = createStateStore({ wakeRoot: root });
    const indexFile = runSummaryIndexFile(root, '2026-07-05');

    await Promise.all([
      store.writeRunRecord(
        runRecord({
          runId: 'run-concurrent-a',
          startedAt: '2026-07-05T12:00:00.000Z',
        }),
      ),
      store.writeRunRecord(
        runRecord({
          runId: 'run-concurrent-b',
          startedAt: '2026-07-05T12:01:00.000Z',
        }),
      ),
    ]);

    const index = JSON.parse(await readFile(indexFile, 'utf8')) as { entries: RunRecord[] };
    expect(index.entries.map((entry) => entry.runId).sort()).toEqual([
      'run-concurrent-a',
      'run-concurrent-b',
    ]);
  });

  it('recovers a full record via the date bucket when the flat run file is missing, without a full unstripped scan', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    // Simulate a flat-file-missing record (e.g. cleaned up separately) that
    // still has its date-bucket copy - readRunRecord's fallback used to be
    // listRecentRunRecords(500) (full, unstripped scan of up to 500 records),
    // which buildBoard calls once per work item. Write directly to the
    // by-date path only, bypassing writeRunRecord's dual-write, so the flat
    // read fails and the fallback path is actually exercised.
    const record = runRecord({
      runId: 'run-bucket-only',
      startedAt: '2026-07-05T12:00:00.000Z',
      metadata: { stdout: 'x'.repeat(1000) },
    });
    await mkdir(join(root, '.wake', 'runs', 'by-date', '2026-07-05'), { recursive: true });
    await writeFile(
      paths.runDateFile('2026-07-05', 'run-bucket-only'),
      JSON.stringify(record),
      'utf8',
    );

    const found = await store.readRunRecord('run-bucket-only');
    expect(found?.metadata?.stdout).toBe('x'.repeat(1000));
  });

  it('lists recent work-item events from projection ids without scanning event history', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-one',
        occurredAt: '2026-06-01T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:01.000Z',
      }),
    );
    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-two',
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:02.000Z',
      }),
    );
    await writeFile(paths.eventFile('1999-01-01'), '{not json\n', 'utf8');
    await store.writeIssueState(issueState({ recentEventIds: ['evt-one', 'evt-two'] }));

    const recentEvents = await store.listEventEnvelopesForWorkItem(workId(7), 1);

    expect(recentEvents.map((event) => event.eventId)).toEqual(['evt-two']);
  });

  it('writes and reads github poll state records', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeSourceState({
      schemaVersion: 1,
      source: 'github',
      key: 'atolis-hq/wake',
      lastSuccessfulPollAt: '2026-07-05T12:00:00.000Z',
    });

    const saved = await store.readSourceState('github', 'atolis-hq/wake');
    expect(saved?.lastSuccessfulPollAt).toBe('2026-07-05T12:00:00.000Z');
  });

  it('does not treat a per-runner quota pause as a global pause (#67 sideways fallback)', async () => {
    const store = createStateStore({ wakeRoot: root });
    await store.writeLedger({
      schemaVersion: 1,
      runners: {
        'claude-haiku': { pausedUntil: '2026-07-08T01:10:00.000Z', failureCount: 1 },
      },
    });

    // A paused runner should not stop the whole tick loop - routing falls
    // sideways to another candidate instead; only the manual pause file does.
    await expect(store.isPaused(new Date('2026-07-08T01:09:59.000Z'))).resolves.toBe(false);
  });

  it('returns null for a missing issue-state file on first run', async () => {
    const store = createStateStore({ wakeRoot: root });

    await expect(store.readIssueState(workId(404))).resolves.toBeNull();
    await expect(store.listIssueStates()).resolves.toEqual([]);
  });

  it('flags invalid issue-state files instead of treating them as absent', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.writeIssueState(issueState({ number: 7 }));
    await mkdir(join(paths.dataRoot, 'state'), { recursive: true });
    await writeFile(
      paths.workItemStateFile(workId(8)),
      JSON.stringify({
        ...issueState({ number: 8 }),
        wake: {
          ...issueState({ number: 8 }).wake,
          stage: 8,
        },
      }),
      'utf8',
    );

    await expect(store.listIssueStates()).rejects.toBeInstanceOf(StateHealthError);

    const report = await store.validateStateHealth();
    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        surface: 'state',
        kind: 'corrupted',
        path: paths.workItemStateFile(workId(8)),
      }),
    );
  });

  it('flags malformed event JSONL instead of returning an empty event list', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await mkdir(join(paths.dataRoot, 'events'), { recursive: true });
    await writeFile(paths.eventFile('2026-07-05'), '{"eventId": "truncated"\n', 'utf8');

    await expect(store.listEventEnvelopes()).rejects.toBeInstanceOf(StateHealthError);

    const report = await store.validateStateHealth();
    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        surface: 'events',
        kind: 'corrupted',
        path: `${paths.eventFile('2026-07-05')}:1`,
      }),
    );
  });

  it('flags a run-record summary index whose entry count differs from date-bucket run files', async () => {
    const store = createStateStore({ wakeRoot: root });
    const indexFile = runSummaryIndexFile(root, '2026-07-05');

    await store.writeRunRecord(
      runRecord({
        runId: 'run-present',
        startedAt: '2026-07-05T12:00:00.000Z',
      }),
    );
    await writeFile(
      indexFile,
      JSON.stringify({ schemaVersion: 1, date: '2026-07-05', entries: [] }),
      'utf8',
    );

    const report = await store.validateStateHealth();

    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        surface: 'runs',
        kind: 'incomplete',
        path: indexFile,
      }),
    );
  });

  it('archives old terminal issue states out of the default scan but keeps direct reads working', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.writeIssueState(
      issueState({
        number: 7,
        stage: 'done',
        syncedAt: '2026-07-01T12:00:00.000Z',
      }),
    );
    await store.writeIssueState(
      issueState({
        number: 8,
        stage: 'implement',
        syncedAt: '2026-06-01T12:00:00.000Z',
      }),
    );

    const states = await store.listIssueStates({
      archiveFreshnessDays: 5,
      now: new Date('2026-07-11T12:00:00.000Z'),
    });

    expect(states.map((state) => state.issue.number)).toEqual([8]);
    await expect(readFile(paths.archivedWorkItemStateFile(workId(7)), 'utf8')).resolves.toContain(
      'Spec',
    );
    await expect(store.readIssueState(workId(7))).resolves.toMatchObject({
      issue: { number: 7 },
    });
  });

  it('does not mistake reverse-index shards for projections', async () => {
    const store = createStateStore({ wakeRoot: root });
    const paths = createWakePaths(root);

    await store.writeIssueState(issueState({ number: 7 }));
    await mkdir(paths.resourceIndexRoot, { recursive: true });
    await writeFile(
      paths.resourceIndexShardFile('ab'),
      JSON.stringify({ 'github:issue:atolis-hq/wake#7': workId(7) }),
      'utf8',
    );

    const states = await store.listIssueStates();

    expect(states.map((state) => state.workItemKey)).toEqual([workId(7)]);
  });

  it('lists issue states by chronological work item key order', async () => {
    const store = createStateStore({ wakeRoot: root });
    const newestKey = 'work-01JZ0000000000000000000009';
    const oldestKey = 'work-01JZ0000000000000000000007';
    const middleKey = 'work-01JZ0000000000000000000008';

    await store.writeIssueState(issueState({ number: 9, workItemKey: newestKey }));
    await store.writeIssueState(issueState({ number: 7, workItemKey: oldestKey }));
    await store.writeIssueState(issueState({ number: 8, workItemKey: middleKey }));

    const states = await store.listIssueStates();

    expect(states.map((state) => state.workItemKey)).toEqual([oldestKey, middleKey, newestKey]);
  });

  it('lists recent events by walking day files backward until the limit is satisfied', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-old',
        ingestedAt: '2026-07-01T12:00:00.000Z',
      }),
    );
    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-new-1',
        ingestedAt: '2026-07-05T12:00:00.000Z',
      }),
    );
    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-new-2',
        ingestedAt: '2026-07-05T12:00:01.000Z',
      }),
    );

    const events = await store.listRecentEventEnvelopes({ limit: 2 });

    expect(events.map((event) => event.eventId)).toEqual(['evt-new-2', 'evt-new-1']);
  });
});
