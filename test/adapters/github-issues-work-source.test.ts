import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createGitHubIssuesWorkSource } from '../../src/adapters/github/github-issues-work-source.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

/**
 * A stable, ULID-shaped work id per issue number. The source never mints or
 * reads these — the resolver in tick-runner does — but fixtures that seed a
 * projection for the source's poll-dedup/echo reads still need one. Real ids
 * come from createWorkId().
 */
function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

/**
 * A resource index already holding the origin-ticket registration an earlier
 * tick's mint would have written. Fixtures that seed a projection and then poll
 * the same ticket need this: the source resolves its poll-dedup/echo state
 * through the index, so without the entry the ticket correctly reads as unseen.
 */
async function seededResourceIndex(issueNumbers: number[]) {
  const resourceIndex = createFakeResourceIndex();
  for (const issueNumber of issueNumbers) {
    await resourceIndex.register(`github:issue:atolis-hq/wake#${issueNumber}`, workId(issueNumber));
  }
  return resourceIndex;
}

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
      resourceIndex: createFakeResourceIndex(),
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

  it('polls unkeyed events carrying github:issue:<repo>#<number> and never a workItemKey (spec D1)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [
          {
            number: 82,
            title: 'Example',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/issues/82',
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
            html_url: 'https://github.com/atolis-hq/wake/issues/82#issuecomment-101',
          },
        ],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();
    expect(events).toHaveLength(2);

    // The source has no obligation to know the work item, and must not invent
    // an identity: a central resolver stamps workItemKey after the poll.
    for (const event of events) {
      expect(event).not.toHaveProperty('workItemKey');
      expect(event.sourceRefs.resourceUri).toBe('github:issue:atolis-hq/wake#82');
    }
  });

  it('isolates a poll failure to the failing repo so other repos still poll this tick (E3)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/broken-repo', 'atolis-hq/healthy-repo'];

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async (owner: string, repo: string) => {
          if (repo === 'broken-repo') {
            throw new Error('simulated GitHub API failure');
          }
          return [
            {
              number: 42,
              title: 'Healthy issue',
              body: 'Body',
              state: 'open',
              html_url: 'https://github.com/atolis-hq/healthy-repo/issues/42',
              created_at: '2026-07-05T12:00:00.000Z',
              updated_at: '2026-07-05T12:00:00.000Z',
              labels: [{ name: 'wake:queue' }],
              assignees: [],
            },
          ];
        },
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();

    expect(events.map((event) => event.sourceEventType)).toEqual(['ticket.upsert']);
    expect(events[0]?.sourceRefs.repo).toBe('atolis-hq/healthy-repo');

    // The failing repo's cursor must not advance, so the next tick retries it.
    expect(await store.readSourceState('github', 'atolis-hq/broken-repo')).toBeNull();
    expect(await store.readSourceState('github', 'atolis-hq/healthy-repo')).not.toBeNull();

    consoleError.mockRestore();
  });

  it('marks a Wake-authored comment as bot-authored via the hidden marker, even when the account type is User (#145)', async () => {
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
            id: 102,
            body: '<!-- wake:agent -->\n\n**Wake** _(Wake)_\n\nWorking on it.',
            // Wake's own GitHub account is a normal 'User', not a 'Bot' — the
            // marker is the only signal available if expectedEcho missed this
            // comment (e.g. Wake crashed before recording delivery).
            user: { login: 'atolis-hq-agent', type: 'User' },
            created_at: '2026-07-05T12:05:00.000Z',
            updated_at: '2026-07-05T12:05:00.000Z',
            html_url: 'https://github.com/atolis-hq/wake/issues/12#issuecomment-102',
          },
        ],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();
    const commentEvent = events.find((event) => event.sourceEventType === 'ticket.comment.created');
    expect(commentEvent?.derivedHints?.botAuthoredComment).toBe(true);
  });

  it("marks a comment from Wake's own authenticated login as bot-authored even with no marker (#258 follow-up)", async () => {
    // A comment posted by direct API/CLI call (not through formatWakeComment)
    // carries neither the marker nor a 'Bot' account type — without a
    // selfLogin check this looks like a fresh human reply and re-triggers
    // another Wake run against itself.
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
            id: 103,
            body: 'Done in abc123. No marker, posted via gh api directly.',
            user: { login: 'atolis-hq-agent', type: 'User' },
            created_at: '2026-07-05T12:05:00.000Z',
            updated_at: '2026-07-05T12:05:00.000Z',
            html_url: 'https://github.com/atolis-hq/wake/issues/12#issuecomment-103',
          },
        ],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
      selfLogin: 'atolis-hq-agent',
    });

    const events = await workSource.pollEvents();
    const commentEvent = events.find((event) => event.sourceEventType === 'ticket.comment.created');
    expect(commentEvent?.derivedHints?.botAuthoredComment).toBe(true);
  });

  it('does not mark an unmarked comment from a different login as bot-authored', async () => {
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
            id: 104,
            body: 'Please also handle the null case.',
            user: { login: 'a-real-reviewer', type: 'User' },
            created_at: '2026-07-05T12:05:00.000Z',
            updated_at: '2026-07-05T12:05:00.000Z',
            html_url: 'https://github.com/atolis-hq/wake/issues/12#issuecomment-104',
          },
        ],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
      selfLogin: 'atolis-hq-agent',
    });

    const events = await workSource.pollEvents();
    const commentEvent = events.find((event) => event.sourceEventType === 'ticket.comment.created');
    expect(commentEvent?.derivedHints?.botAuthoredComment).toBe(false);
  });

  it('never emits PR-shaped issues', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [
          {
            number: 12,
            title: 'Plain Issue',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/issues/12',
            created_at: '2026-07-05T12:00:00.000Z',
            updated_at: '2026-07-05T12:00:00.000Z',
            labels: [{ name: 'wake:queue' }],
            assignees: [],
          },
          {
            number: 999,
            title: 'Example PR',
            body: 'Body',
            state: 'open',
            html_url: 'https://github.com/atolis-hq/wake/pull/999',
            created_at: '2026-07-05T12:00:00.000Z',
            updated_at: '2026-07-05T12:00:00.000Z',
            labels: [{ name: 'wake:queue' }],
            assignees: [],
            pull_request: { url: 'https://api.github.com/repos/atolis-hq/wake/pulls/999' },
          },
        ],
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const events = await workSource.pollEvents();
    const upsertEvents = events.filter((e) => e.sourceEventType === 'ticket.upsert');
    expect(upsertEvents).toHaveLength(1);
    expect((upsertEvents[0]?.payload.ticket as { number: number }).number).not.toBe(999);
  });

  it('polls issues updated within the previous successful poll hour overlap', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];
    await store.writeSourceState({
      schemaVersion: 1,
      source: 'github',
      key: 'atolis-hq/wake',
      lastSuccessfulPollAt: '2026-07-05T12:00:00.000Z',
    });
    const listIssues = vi.fn(async () => []);

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues,
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.pollEvents();

    expect(listIssues).toHaveBeenCalledWith(
      'atolis-hq',
      'wake',
      config.sources.github.polling.maxIssuesPerRepo,
      '2026-07-05T11:00:00.000Z',
    );
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
      resourceIndex: await seededResourceIndex([12]),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const firstPoll = await workSource.pollEvents();
    for (const event of firstPoll) {
      // Stands in for the resolver: polled events are unkeyed, and the store
      // only ever persists events a workItemKey has been stamped on.
      await store.appendEventEnvelope({ ...event, workItemKey: workId(12) });
    }
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(12),
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
      correlatedResources: [],
    });

    const secondPoll = await workSource.pollEvents();
    expect(secondPoll).toEqual([]);
  });

  // The poll path runs once per polled issue. Resolving each one by scanning
  // every projection on disk makes a poll O(issues x projections) file reads,
  // which is exactly the unbounded growth the 256-shard index exists to avoid
  // ("don't assume the list of issues will remain small"). The source resolves
  // its own constructed uri through the index instead: one shard read.
  it('resolves poll-dedup state through the resource index, never by scanning every projection', async () => {
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const store = createStateStore({ wakeRoot: root });
    let listIssueStatesCalls = 0;
    const countingStore = {
      ...store,
      async listIssueStates(...args: Parameters<typeof store.listIssueStates>) {
        listIssueStatesCalls += 1;
        return store.listIssueStates(...args);
      },
    };

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(12),
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
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
      correlatedResources: [],
    });

    // Unrelated work items: under a scan these are read on every poll; under
    // the index they are never touched.
    for (const other of [500, 501, 502]) {
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(other),
        issue: {
          repo: 'atolis-hq/other',
          number: other,
          title: 'Other',
          body: '',
          labels: [],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: `https://example.test/issues/${other}`,
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
        correlatedResources: [],
      });
    }

    const resourceIndex = createFakeResourceIndex();
    await resourceIndex.register('github:issue:atolis-hq/wake#12', workId(12));

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
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: countingStore,
      config,
      resourceIndex,
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    // Dedup still works: the issue is unchanged, so nothing is re-emitted.
    expect(await workSource.pollEvents()).toEqual([]);
    expect(listIssueStatesCalls).toBe(0);
  });

  it('drops inbound comments whose provider ids match expected echoes', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(12),
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
      correlatedResources: [],
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
      resourceIndex: await seededResourceIndex([12]),
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
      workItemKey: workId(13),
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
      correlatedResources: [],
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
      resourceIndex: await seededResourceIndex([13]),
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const deliveryEvents = await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-1',
        workItemKey: workId(12),
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

    const [, , , postedBody] = createComment.mock.calls[0] as unknown as [
      string,
      string,
      number,
      string,
    ];
    expect(postedBody).toContain('<!-- wake:agent -->');
  });

  it('rejects delivery instead of silently dropping an intent with missing sourceRefs (E5)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [],
        listComments: async () => [],
        createComment: vi.fn(),
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await expect(
      workSource.deliverIntent({
        event: createEventEnvelope({
          eventId: 'intent-missing-refs',
          workItemKey: workId(12),
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: 'wake',
          sourceEventType: 'wake.publish.intent.requested',
          sourceRefs: {},
          occurredAt: '2026-07-05T12:00:00.000Z',
          ingestedAt: '2026-07-05T12:00:00.000Z',
          trigger: 'context-only',
          payload: { kind: 'status-update', body: 'Handled' },
        }),
      }),
    ).rejects.toThrow(/missing sourceRefs/);
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-2',
        workItemKey: workId(12),
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
    expect(postedBody).toContain('**Wake**');
    expect(postedBody).toContain('Wake 0.1.0-dev');
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

  it('links Wake to the control plane URL when ngrok has published one', async () => {
    const createComment = vi.fn();
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.enabled = true;
    config.sources.github.repos = ['atolis-hq/wake'];
    await writeFile(join(root, 'control-plane-ui-url'), 'https://example.ngrok-free.app\n');

    const workSource = createGitHubIssuesWorkSource({
      client: {
        listIssues: async () => [],
        listComments: async () => [],
        createComment,
        setLabels: vi.fn(),
      },
      stateStore: store,
      config,
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-linked-ui',
        workItemKey: workId(12),
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: 'wake.publish.intent.requested',
        sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 12 },
        occurredAt: '2026-07-05T12:00:00.000Z',
        ingestedAt: '2026-07-05T12:00:00.000Z',
        trigger: 'context-only',
        payload: { kind: 'status-update', body: 'Opened a PR' },
      }),
    });

    const [, , , postedBody] = createComment.mock.calls[0] as [string, string, number, string];
    expect(postedBody).toContain('**[Wake](https://example.ngrok-free.app/)**');
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-2b',
        workItemKey: workId(13),
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-2cursor',
        workItemKey: workId(16),
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-2c',
        workItemKey: workId(14),
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-2d',
        workItemKey: workId(15),
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
      workItemKey: workId(12),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const deliveryEvents = await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-labels-1',
        workItemKey: workId(12),
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
    expect(setLabels).toHaveBeenCalledWith('atolis-hq', 'wake', 12, [
      'bug',
      'wake:status.working',
      'wake:stage.queue',
    ]);
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
      workItemKey: workId(13),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-labels-2',
        workItemKey: workId(13),
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
    expect(setLabels).toHaveBeenCalledWith('atolis-hq', 'wake', 13, [
      'bug',
      'wake:status.completed',
      'wake:stage.done',
    ]);
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
      workItemKey: workId(14),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    const deliveryEvents = await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-labels-3',
        workItemKey: workId(14),
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-approval-1',
        workItemKey: workId(15),
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
    expect(postedBody).toContain('/changes');
    expect(postedBody).toContain('/ask');
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
      resourceIndex: createFakeResourceIndex(),
      now: () => new Date('2026-07-05T12:10:00.000Z'),
    });

    await workSource.deliverIntent({
      event: createEventEnvelope({
        eventId: 'intent-status-1',
        workItemKey: workId(16),
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
