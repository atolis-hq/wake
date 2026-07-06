import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createGitHubIssuesWorkSource } from '../../src/adapters/github/github-issues-work-source.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

describe('github issues work source', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-github-work-source-'));
  });

  it('emits canonical ticket events for a newly discovered issue and comment', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [
          {
            number: 12,
            title: 'Example',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/issues/12',
            created_at: '2026-07-05T12:00:00.000Z',
            updated_at: '2026-07-05T12:00:00.000Z',
            labels: [{ name: 'wake:queue' }],
            assignees: [],
          },
        ],
        listComments: async () => [
          {
            id: 101,
            body: 'Need more detail',
            user: { login: 'alice' },
            created_at: '2026-07-05T12:05:00.000Z',
            updated_at: '2026-07-05T12:05:00.000Z',
            html_url: 'https://github.com/atolis-hq/wake/issues/12#issuecomment-101',
          },
        ],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();
    expect(events.map((event) => event.sourceEventType)).toEqual([
      'ticket.upsert',
      'ticket.comment.created',
    ]);
  });

  it('does not re-emit unchanged issues on the next poll', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [
          {
            number: 12,
            title: 'Example',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/issues/12',
            created_at: '2026-07-05T12:00:00.000Z',
            updated_at: '2026-07-05T12:00:00.000Z',
            labels: [{ name: 'wake:queue' }],
            assignees: [],
          },
        ],
        listComments: async () => [
          {
            id: 101,
            body: 'Need more detail',
            user: { login: 'alice' },
            created_at: '2026-07-05T12:05:00.000Z',
            updated_at: '2026-07-05T12:05:00.000Z',
            html_url: 'https://github.com/atolis-hq/wake/issues/12#issuecomment-101',
          },
        ],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const firstPoll = await workSource.pollEvents();
    for (const event of firstPoll) {
      await store.appendEventEnvelope(event);
    }
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#12',
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [
        {
          id: '101',
          body: 'Need more detail',
          author: { login: 'alice' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isWakeAuthored: false,
        },
      ],
      latestComment: {
        id: '101',
        body: 'Need more detail',
        author: { login: 'alice' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isWakeAuthored: false,
      },
      wake: {
        stage: 'queue',
        attempts: 0,
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
      },
      context: {},
    });

    const secondPoll = await workSource.pollEvents();
    expect(secondPoll).toEqual([]);
  });

  it('publishes outbound comments for wake intents', async () => {
    const createComment = vi.fn();
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [],
        listComments: async () => [],
        createComment,
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const deliveryEvents = await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-1',
        workItemKey: 'atolis-hq/wake#12',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 12 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: { kind: 'status-update', body: 'Handled' },
      }),
    });

    expect(createComment).toHaveBeenCalledOnce();
    expect(deliveryEvents[0]?.sourceEventType).toBe('ticket.reply.published');
  });

  it('formats outbound comments with attribution, model, and a resume command', async () => {
    const createComment = vi.fn();
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [],
        listComments: async () => [],
        createComment,
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-2',
        workItemKey: 'atolis-hq/wake#12',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 12 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'status-update',
          body: 'Opened a PR',
          action: 'implement',
          runId: 'run-12-1',
          sessionId: 'session-abc',
          model: 'haiku',
          workspacePath: 'C:\\wake\\.wake\\workspaces\\atolis-hq__wake\\12',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('**Eddy**');
    expect(postedBody).toContain('stage `implement`');
    expect(postedBody).toContain('model `haiku`');
    expect(postedBody).toContain('run `run-12-1`');
    expect(postedBody).toContain('claude --resume session-abc');
    expect(postedBody).toContain('cd "C:\\wake\\.wake\\workspaces\\atolis-hq__wake\\12"');
    expect(postedBody).toContain('<!-- wake -->');
  });

  it('replaces only wake status labels when syncing a status update', async () => {
    const createComment = vi.fn();
    const setLabels = vi.fn();
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#12',
      issue: {
        repo: 'atolis-hq/wake',
        number: 12,
        title: 'Example',
        body: 'Body',
        labels: ['bug', 'wake:status.pending'],
        assignees: [],
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        attempts: 0,
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
      },
      context: {},
    });

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [],
        listComments: async () => [],
        createComment,
        setLabels,
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-status-1',
        workItemKey: 'atolis-hq/wake#12',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.status.label.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 12 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: { statusLabel: 'wake:status.completed' },
      }),
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(setLabels).toHaveBeenCalledWith(
      'atolis-hq',
      'wake',
      12,
      ['bug', 'wake:status.completed'],
    );
  });
});
