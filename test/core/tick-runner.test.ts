import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  it('writes a running run record before invoking the runner', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runFileSnapshot = '';

    const runner = {
      async run() {
        const runFiles = await readdir(join(root, 'runs'));
        runFileSnapshot = await readFile(join(root, 'runs', runFiles[0]!), 'utf8');
        return { result: 'Runner output\nDONE', model: 'test-model', cli: 'test-cli', session_id: 'session-1' };
      },
    };

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 9,
            title: 'Implement',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner,
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(runFileSnapshot).toContain('"status": "running"');
  });

  it('creates event audit records for sync and completion', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 10,
            title: 'Refine',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:00.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'Fake runner completed\nDONE', model: 'test-model', cli: 'test-cli', session_id: 'fake-session-1' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"sourceEventType":"fake.issue.upsert"');
    expect(events).toContain('"sourceEventType":"wake.run.completed"');
  });

  it('persists outbound publish intents before sink delivery', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const ticketingSystem = createFakeTicketingSystem({
      tickets: [
        {
          repo: 'atolis-hq/wake',
          number: 11,
          title: 'Clarify',
          body: 'Body',
          labels: ['wake:queue'],
          comments: [],
        },
      ],
      now: () => new Date('2026-07-05T12:00:00.000Z'),
    });

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: ticketingSystem,
      outboundSink: ticketingSystem,
      runner: {
        async run() {
          return {
            result: 'Question for the owner\nBLOCKED',
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'fake-session-2',
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"sourceEventType":"wake.publish.intent.requested"');
    expect(events).toContain('"sourceEventType":"fake.issue.comment.published"');
  });

  it('runs once when a new human comment arrives on an eligible issue', async () => {
    const store = createStateStore({ wakeRoot: root });
    let callCount = 0;
    let pollCount = 0;

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          if (pollCount > 0) {
            pollCount += 1;
            return [];
          }

          pollCount += 1;
          return [
            {
              schemaVersion: 1,
              eventId: 'evt-issue',
              workItemKey: 'atolis-hq/wake#12',
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.upsert',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber: 12,
                sourceUrl: 'https://github.com/atolis-hq/wake/issues/12',
              },
              occurredAt: '2026-07-05T12:00:00.000Z',
              ingestedAt: '2026-07-05T12:00:00.000Z',
              trigger: 'immediate',
              payload: {
                ticket: {
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
              },
            },
            {
              schemaVersion: 1,
              eventId: 'evt-comment',
              workItemKey: 'atolis-hq/wake#12',
              streamScope: 'work-item',
              direction: 'inbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.comment.created',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber: 12,
                commentId: 'c-1',
              },
              occurredAt: '2026-07-05T12:05:00.000Z',
              ingestedAt: '2026-07-05T12:05:00.000Z',
              trigger: 'context-only',
              payload: {
                comment: {
                  id: 'c-1',
                  body: 'Need more detail',
                  author: { login: 'alice' },
                  createdAt: '2026-07-05T12:05:00.000Z',
                  updatedAt: '2026-07-05T12:05:00.000Z',
                },
              },
              derivedHints: {
                wakeAuthoredComment: false,
              },
            },
          ];
        },
      },
      runner: {
        async run() {
          callCount += 1;
          return { result: 'Handled\nDONE', model: 'test-model', cli: 'test-cli', session_id: 'session-2' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();
    await tickRunner.runTick();

    expect(callCount).toBe(1);
  });

  it('publishes working then completed status labels around a successful implement run', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#14',
      issue: {
        repo: 'atolis-hq/wake',
        number: 14,
        title: 'Implement',
        body: 'Body',
        labels: ['wake:refined'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/14',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'refined',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:refined'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.labels.requested') {
            deliveredEvents.push(String(input.event.payload.statusLabel));
            deliveredEvents.push(String(input.event.payload.stageLabel));
          }
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'Implemented\nDONE', model: 'test-model', cli: 'test-cli', session_id: 'session-3' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.refined',
      'wake:status.completed',
      'wake:stage.done',
    ]);
  });

  it('transitions awaiting-approval to done when /approved comment is present', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#30',
      issue: {
        repo: 'atolis-hq/wake',
        number: 30,
        title: 'Approval Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/30',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-approval',
          body: '/approved',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isWakeAuthored: false,
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-approval',
        body: '/approved',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isWakeAuthored: false,
        isBotAuthored: false,
      },
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {
        pendingApprovalAction: 'implement',
      },
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.labels.requested') {
            deliveredEvents.push(String(input.event.payload.statusLabel));
            deliveredEvents.push(String(input.event.payload.stageLabel));
          }
          return [];
        },
      },
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect((result as { nextStage?: string }).nextStage).toBe('done');
    expect(runnerCallCount).toBe(0);
    expect(deliveredEvents).toContain('wake:stage.done');
  });

  it('invokes the agent when awaiting-approval but comment is not /approved', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#31',
      issue: {
        repo: 'atolis-hq/wake',
        number: 31,
        title: 'Approval Feedback Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/31',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-feedback',
          body: 'Please revise section 3.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isWakeAuthored: false,
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-feedback',
        body: 'Please revise section 3.',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isWakeAuthored: false,
        isBotAuthored: false,
      },
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {
        pendingApprovalAction: 'refine',
      },
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'Revised plan.\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(runnerCallCount).toBe(1);
  });

  it('writes a failed run record and publishes failed labels when workspace prep throws', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#20',
      issue: {
        repo: 'atolis-hq/wake',
        number: 20,
        title: 'Implement',
        body: 'Body',
        labels: ['wake:refined'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/20',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'refined',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:refined'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.labels.requested') {
            deliveredEvents.push(String(input.event.payload.statusLabel));
            deliveredEvents.push(String(input.event.payload.stageLabel));
          }
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: {
        async prepareWorkspace() { throw new Error('git network failure'); },
        async prepareReadOnlyClone() { throw new Error('git network failure'); },
      },
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect((result as { sentinel?: string }).sentinel).toBe('FAILED');
    expect((result as { nextStage?: string }).nextStage).toBe('failed');
    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.refined',
      'wake:status.failed',
      'wake:stage.failed',
    ]);

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    const completedEvent = events.split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
      .find((e: { payload?: { reason?: string } }) => e.payload?.reason === 'runner:infrastructure-error');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.payload.sentinel).toBe('FAILED');

    const runFiles = await readdir(join(root, 'runs'));
    const runRecord = JSON.parse(await readFile(join(root, 'runs', runFiles[0]!), 'utf8'));
    expect(runRecord.status).toBe('failed');
  });

  it('publishes a failed status label when a run ends in FAILED', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#15',
      issue: {
        repo: 'atolis-hq/wake',
        number: 15,
        title: 'Refine',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        state: 'open',
        url: 'https://example.test/issues/15',
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

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.labels.requested') {
            deliveredEvents.push(String(input.event.payload.statusLabel));
            deliveredEvents.push(String(input.event.payload.stageLabel));
          }
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'Nope\nFAILED', model: 'test-model', cli: 'test-cli', session_id: 'session-4' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.queue',
      'wake:status.failed',
      'wake:stage.failed',
    ]);
  });
});
