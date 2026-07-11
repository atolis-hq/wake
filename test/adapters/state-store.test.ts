import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';

function issueState(input?: {
  recentEventIds?: string[];
  number?: number;
}): IssueStateRecord {
  const number = input?.number ?? 7;

  return {
    schemaVersion: 1,
    workItemKey: `atolis-hq/wake#${number}`,
    issue: {
      repo: 'atolis-hq/wake',
      number,
      title: 'Spec',
      body: 'Body',
      labels: ['wake:queue'],
      assignees: [],
      isPullRequest: false,
      state: 'open',
      url: `https://example.test/issues/${number}`,
      createdAt: '2026-07-05T12:00:00.000Z',
      updatedAt: '2026-07-05T12:00:00.000Z',
    },
    comments: [],
    wake: {
      stage: 'queue',
      stageHistory: [],
      recentEventIds: input?.recentEventIds ?? [],
      syncedAt: '2026-07-05T12:00:00.000Z',
      expectedEcho: { commentIds: [], labels: [] },
    },
    context: {},
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
    workItemKey: input.workItemKey ?? 'atolis-hq/wake#7',
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

  it('writes and reads issue state records in the canonical layout', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState(issueState());

    const saved = await store.readIssueState('atolis-hq/wake', 7);
    expect(saved?.issue.number).toBe(7);
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

    const recentEvents = await store.listEventEnvelopesForWorkItem('atolis-hq/wake#7', 1);

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
    await writeFile(
      join(root, 'state', 'atolis-hq__wake', '8.json'),
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
});
