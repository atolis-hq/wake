import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import type { EventEnvelope, IssueStateRecord, RunRecord } from '../../src/domain/types.js';

/**
 * A stable, ULID-shaped work id per issue number, so a fixture can name the
 * key it expects without minting. Real ids come from createWorkId().
 */
function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

function issueState(input?: {
  recentEventIds?: string[];
  number?: number;
  stage?: IssueStateRecord['wake']['stage'];
  issueState?: IssueStateRecord['issue']['state'];
  syncedAt?: string;
}): IssueStateRecord {
  const number = input?.number ?? 7;
  const syncedAt = input?.syncedAt ?? '2026-07-05T12:00:00.000Z';

  return {
    schemaVersion: 1,
    workItemKey: workId(number),
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
}): RunRecord {
  return {
    schemaVersion: 1,
    runId: input.runId,
    repo: 'atolis-hq/wake',
    issueNumber: input.issueNumber ?? 7,
    action: 'implement',
    status: input.status ?? 'completed',
    startedAt: input.startedAt,
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

describe('state store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-state-store-'));
  });

  it('writes and reads issue state records at a flat state/<workId>.json', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState());

    // No provider, repo, or issue segment anywhere in the path (spec §3).
    await expect(readFile(join(root, 'state', `${workId(7)}.json`), 'utf8')).resolves.toContain(
      'Spec',
    );

    const saved = await store.readIssueState(workId(7));
    expect(saved?.issue.number).toBe(7);
  });

  it('finds a projection by the ticket it represents, via its retained issue snapshot', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState({ number: 7 }));
    await store.writeIssueState(issueState({ number: 8 }));

    const saved = await store.findIssueStateByIssueRef({
      repo: 'atolis-hq/wake',
      issueNumber: 8,
      source: 'github',
    });

    expect(saved?.workItemKey).toBe(workId(8));
    expect(
      await store.findIssueStateByIssueRef({ repo: 'atolis-hq/wake', issueNumber: 404 }),
    ).toBeNull();
  });

  it('buckets event log files by ingestedAt', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.appendEventEnvelope(
      eventEnvelope({
        eventId: 'evt-stale-upstream',
        occurredAt: '2026-06-01T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:01.000Z',
      }),
    );

    await expect(readFile(join(root, 'events', '2026-06-01.jsonl'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8')).toContain(
      'evt-stale-upstream',
    );
  });

  it('does not append an event whose id is already persisted', async () => {
    const store = createStateStore({ wakeRoot: root });
    const event = eventEnvelope({ eventId: 'evt-once' });

    await store.appendEventEnvelope(event);
    await store.appendEventEnvelope(event);

    const lines = (await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it('writes run records into date buckets while preserving id reads and full listing', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeRunRecord(runRecord({
      runId: 'run-old',
      startedAt: '2026-07-04T12:00:00.000Z',
    }));
    await store.writeRunRecord(runRecord({
      runId: 'run-today',
      startedAt: '2026-07-05T12:00:00.000Z',
      status: 'failed',
    }));

    await expect(readFile(join(root, 'runs', 'by-date', '2026-07-05', 'run-today.json'), 'utf8'))
      .resolves.toContain('run-today');
    await expect(store.readRunRecord('run-today')).resolves.toMatchObject({ status: 'failed' });
    await expect(store.listRunRecordsForDate('2026-07-05')).resolves.toHaveLength(1);
    await expect(store.listRunRecords()).resolves.toHaveLength(2);
  });

  it('lists recent work-item events from projection ids without scanning event history', async () => {
    const store = createStateStore({ wakeRoot: root });

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
    await writeFile(join(root, 'events', '1999-01-01.jsonl'), '{not json\n', 'utf8');
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

  it('skips invalid issue-state files instead of returning an empty list', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState({ number: 7 }));
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(
      join(root, 'state', `${workId(8)}.json`),
      JSON.stringify({
        ...issueState({ number: 8 }),
        wake: {
          ...issueState({ number: 8 }).wake,
          stage: 'not-a-stage',
        },
      }),
      'utf8',
    );

    const states = await store.listIssueStates();

    expect(states).toHaveLength(1);
    expect(states[0]?.issue.number).toBe(7);
  });

  it('archives old terminal issue states out of the default scan but keeps direct reads working', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState({
      number: 7,
      stage: 'done',
      syncedAt: '2026-07-01T12:00:00.000Z',
    }));
    await store.writeIssueState(issueState({
      number: 8,
      stage: 'implement',
      syncedAt: '2026-06-01T12:00:00.000Z',
    }));

    const states = await store.listIssueStates({
      archiveFreshnessDays: 5,
      now: new Date('2026-07-11T12:00:00.000Z'),
    });

    expect(states.map((state) => state.issue.number)).toEqual([8]);
    await expect(readFile(join(root, 'state', 'archive', `${workId(7)}.json`), 'utf8'))
      .resolves.toContain('Spec');
    await expect(store.readIssueState(workId(7))).resolves.toMatchObject({
      issue: { number: 7 },
    });
  });

  it('does not mistake reverse-index shards for projections', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState({ number: 7 }));
    await mkdir(join(root, 'state', 'index'), { recursive: true });
    await writeFile(
      join(root, 'state', 'index', 'ab.json'),
      JSON.stringify({ 'github:issue:atolis-hq/wake#7': workId(7) }),
      'utf8',
    );

    const states = await store.listIssueStates();

    expect(states.map((state) => state.workItemKey)).toEqual([workId(7)]);
  });

  it('lists recent events by walking day files backward until the limit is satisfied', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.appendEventEnvelope(eventEnvelope({
      eventId: 'evt-old',
      ingestedAt: '2026-07-01T12:00:00.000Z',
    }));
    await store.appendEventEnvelope(eventEnvelope({
      eventId: 'evt-new-1',
      ingestedAt: '2026-07-05T12:00:00.000Z',
    }));
    await store.appendEventEnvelope(eventEnvelope({
      eventId: 'evt-new-2',
      ingestedAt: '2026-07-05T12:00:01.000Z',
    }));

    const events = await store.listRecentEventEnvelopes({ limit: 2 });

    expect(events.map((event) => event.eventId)).toEqual(['evt-new-2', 'evt-new-1']);
  });
});
