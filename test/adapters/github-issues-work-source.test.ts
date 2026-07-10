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
    expect(events[0]?.payload.ticket).toMatchObject({
      number: 12,
      isPullRequest: false,
    });
  });

  it('marks normalized ticket upserts as pull requests when the GitHub payload is a PR', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [
          {
            number: 76,
            title: 'Example PR',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/pull/76',
            created_at: '2026-07-05T12:00:00.000Z',
            updated_at: '2026-07-05T12:00:00.000Z',
            labels: [{ name: 'wake:queue' }],
            assignees: [],
            pull_request: { url: 'https://api.github.com/repos/atolis-hq/wake/pulls/76' },
          },
        ],
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.ticket).toMatchObject({
      number: 76,
      isPullRequest: true,
    });
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
        isPullRequest: false,
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
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: '101',
        body: 'Need more detail',
        author: { login: 'alice' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const secondPoll = await workSource.pollEvents();
    expect(secondPoll).toEqual([]);
  });

  it('drops inbound comments whose provider ids match expected echoes', async () => {
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
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
        expectedEcho: {
          commentIds: ['202'],
          labels: [],
        },
      },
      context: {},
    });

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
            id: 202,
            body: 'Wake status update',
            user: { login: 'shared-user' },
            created_at: '2026-07-05T12:05:00.000Z',
            updated_at: '2026-07-05T12:05:00.000Z',
            html_url: 'https://github.com/atolis-hq/wake/issues/12#issuecomment-202',
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
    expect(events).toEqual([]);
  });

  it('marks label-only upserts that match expected echoes as context-only', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#13',
      issue: {
        repo: 'atolis-hq/wake',
        number: 13,
        title: 'Example',
        body: 'Body',
        labels: ['bug', 'wake:status.pending', 'wake:stage.queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/13',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
        expectedEcho: {
          commentIds: [],
          labels: ['bug', 'wake:status.working', 'wake:stage.queue'],
        },
      },
      context: {},
    });

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [
          {
            number: 13,
            title: 'Example',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/issues/13',
            created_at: '2026-07-05T12:00:00.000Z',
            updated_at: '2026-07-05T12:01:00.000Z',
            labels: [
              { name: 'bug' },
              { name: 'wake:status.working' },
              { name: 'wake:stage.queue' },
            ],
            assignees: [],
          },
        ],
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.sourceEventType).toBe('ticket.upsert');
    expect(events[0]?.trigger).toBe('context-only');
    expect(events[0]?.derivedHints?.expectedEcho).toBe(true);
  });

  it('publishes outbound comments for wake intents', async () => {
    const createComment = vi.fn(async () => ({ data: { id: 202 } }));
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
    expect(deliveryEvents[0]?.sourceRefs.commentId).toBe('202');
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
          cli: 'Claude',
          duration: '1m30s',
          tokens: '28k',
          workspacePath: 'C:\\wake\\.wake\\workspaces\\atolis-hq__wake\\12',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('**Eddy**');
    expect(postedBody).toContain('stage `implement`');
    expect(postedBody).toContain('cli Claude');
    expect(postedBody).toContain('model `haiku`');
    expect(postedBody).toContain('duration 1m30s');
    expect(postedBody).toContain('tokens 28k');
    expect(postedBody).toContain('run `run-12-1`');
    expect(postedBody).toContain('claude --resume session-abc');
    expect(postedBody).toContain('cd "C:\\wake\\.wake\\workspaces\\atolis-hq__wake\\12"');
    expect(postedBody).not.toContain('<!-- wake -->');
  });

  it('formats Codex resume instructions when the run came from Codex', async () => {
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
        eventId: 'intent-2b',
        workItemKey: 'atolis-hq/wake#13',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 13 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'status-update',
          body: 'Opened a PR',
          action: 'implement',
          runId: 'run-13-1',
          sessionId: 'session-codex',
          model: 'gpt-5.5',
          cli: 'Codex',
          workspacePath: '/wake/workspaces/atolis-hq__wake/13',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('cli Codex');
    expect(postedBody).toContain('codex resume session-codex');
    expect(postedBody).not.toContain('claude --resume session-codex');
  });

  it('formats Cursor resume instructions when the run came from Cursor', async () => {
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
        eventId: 'intent-2cursor',
        workItemKey: 'atolis-hq/wake#16',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 16 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'status-update',
          body: 'Opened a PR',
          action: 'implement',
          runId: 'run-16-1',
          sessionId: 'session-cursor',
          model: 'claude-sonnet-4-6',
          cli: 'Cursor',
          workspacePath: '/wake/workspaces/atolis-hq__wake/16',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('cli Cursor');
    expect(postedBody).toContain('cursor agent --resume=session-cursor');
    expect(postedBody).not.toContain('claude --resume session-cursor');
  });

  it('does not silently fall back to Claude resume instructions when cli is missing', async () => {
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
        eventId: 'intent-2c',
        workItemKey: 'atolis-hq/wake#14',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 14 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'status-update',
          body: 'Opened a PR',
          action: 'implement',
          runId: 'run-14-1',
          sessionId: 'session-missing-cli',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('resume command unavailable');
    expect(postedBody).not.toContain('claude --resume session-missing-cli');
  });

  it('does not silently fall back to Claude resume instructions when cli is unsupported', async () => {
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
        eventId: 'intent-2d',
        workItemKey: 'atolis-hq/wake#15',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 15 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'status-update',
          body: 'Opened a PR',
          action: 'implement',
          runId: 'run-15-1',
          sessionId: 'session-unsupported-cli',
          cli: 'Gemini',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('unsupported runner identity');
    expect(postedBody).not.toContain('claude --resume session-unsupported-cli');
  });

  it('applies both status and stage labels atomically in a single setLabels call', async () => {
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
        labels: ['bug', 'wake:status.pending', 'wake:stage.queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/12',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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

    const deliveryEvents = await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-labels-1',
        workItemKey: 'atolis-hq/wake#12',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.labels.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 12 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: { statusLabel: 'wake:status.working', stageLabel: 'wake:stage.queue' },
      }),
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(setLabels).toHaveBeenCalledOnce();
    expect(setLabels).toHaveBeenCalledWith(
      'atolis-hq',
      'wake',
      12,
      ['bug', 'wake:status.working', 'wake:stage.queue'],
    );
    expect(deliveryEvents[0]?.sourceEventType).toBe('ticket.labels.updated');
  });

  it('replaces old status and stage labels when both change', async () => {
    const createComment = vi.fn();
    const setLabels = vi.fn();
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#13',
      issue: {
        repo: 'atolis-hq/wake',
        number: 13,
        title: 'Example',
        body: 'Body',
        labels: ['bug', 'wake:status.working', 'wake:stage.implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/13',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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
        eventId: 'intent-labels-2',
        workItemKey: 'atolis-hq/wake#13',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.labels.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 13 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: { statusLabel: 'wake:status.completed', stageLabel: 'wake:stage.done' },
      }),
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(setLabels).toHaveBeenCalledOnce();
    expect(setLabels).toHaveBeenCalledWith(
      'atolis-hq',
      'wake',
      13,
      ['bug', 'wake:status.completed', 'wake:stage.done'],
    );
  });

  it('does not call setLabels when no labels change', async () => {
    const createComment = vi.fn();
    const setLabels = vi.fn();
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#14',
      issue: {
        repo: 'atolis-hq/wake',
        number: 14,
        title: 'Example',
        body: 'Body',
        labels: ['bug', 'wake:status.pending', 'wake:stage.implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/14',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:10:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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

    const deliveryEvents = await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-labels-3',
        workItemKey: 'atolis-hq/wake#14',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.labels.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 14 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: { statusLabel: 'wake:status.pending', stageLabel: 'wake:stage.implement' },
      }),
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
    expect(deliveryEvents).toEqual([]);
  });

  it('appends approval instructions for approval-request comments', async () => {
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
        eventId: 'intent-approval-1',
        workItemKey: 'atolis-hq/wake#15',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 15 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'approval-request',
          body: 'Work is ready for review.',
          action: 'implement',
          runId: 'run-15-1',
          model: 'haiku',
          cli: 'Claude',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('/approved');
    expect(postedBody.split('/approved')).toHaveLength(2);
    expect(postedBody).toContain('Work is ready for review.');
  });

  it('does not append approval instructions for non-approval-request comments', async () => {
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
        eventId: 'intent-status-1',
        workItemKey: 'atolis-hq/wake#16',
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 16 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: {
          kind: 'status-update',
          body: 'In progress.',
        },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).not.toContain('/approved');
  });
});
