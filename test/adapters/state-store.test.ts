import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';

describe('state store', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-state-store-'));
  });

  it('writes and reads issue state records in the canonical layout', async () => {
    const store = createStateStore({ wakeRoot: root });

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#7',
      issue: {
        repo: 'atolis-hq/wake',
        number: 7,
        title: 'Spec',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/7',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {},
    });

    const saved = await store.readIssueState('atolis-hq/wake', 7);
    expect(saved?.issue.number).toBe(7);
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
});
