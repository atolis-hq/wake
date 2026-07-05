import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

describe('projection updater', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-projection-updater-'));
  });

  it('builds a work-item projection from correlated event envelopes', async () => {
    const store = createStateStore({ wakeRoot: root });
    const updater = createProjectionUpdater({ stateStore: store });

    const events = [
      createEventEnvelope({
        eventId: 'evt-issue',
        workItemKey: 'atolis-hq/wake#7',
        streamScope: 'global-intake',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.upsert',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 7,
          sourceUrl: 'https://example.test/issues/7',
        },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:01.000Z',
        trigger: 'immediate',
        payload: {
          issue: {
            repo: 'atolis-hq/wake',
            number: 7,
            title: 'Example',
            body: 'Body',
            labels: ['wake:queue'],
            assignees: [],
            state: 'open',
            url: 'https://example.test/issues/7',
            createdAt: '2026-07-05T12:00:00.000Z',
            updatedAt: '2026-07-05T12:00:00.000Z',
          },
        },
      }),
      createEventEnvelope({
        eventId: 'evt-comment',
        workItemKey: 'atolis-hq/wake#7',
        streamScope: 'work-item',
        direction: 'inbound',
        sourceSystem: 'fake-ticketing',
        sourceEventType: 'fake.issue.comment.created',
        sourceRefs: {
          repo: 'atolis-hq/wake',
          issueNumber: 7,
          commentId: 'c-1',
        },
        occurredAt: '2026-07-05T12:05:00.000Z',
        ingestedAt: '2026-07-05T12:05:01.000Z',
        trigger: 'context-only',
        payload: {
          comment: {
            id: 'c-1',
            body: 'Need more detail <!-- wake -->',
            author: { login: 'shared-user' },
            createdAt: '2026-07-05T12:05:00.000Z',
            updatedAt: '2026-07-05T12:05:00.000Z',
          },
        },
        derivedHints: {
          wakeAuthoredComment: true,
        },
      }),
    ];

    for (const event of events) {
      await store.appendEventEnvelope(event);
    }

    await updater.rebuildFromEvents(events);

    const projection = await store.readIssueState('atolis-hq/wake', 7);
    expect(projection?.workItemKey).toBe('atolis-hq/wake#7');
    expect(projection?.latestComment?.id).toBe('c-1');
    expect(projection?.wake.recentEventIds).toEqual(['evt-issue', 'evt-comment']);
  });
});
