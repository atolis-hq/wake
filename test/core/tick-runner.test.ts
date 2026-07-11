import { beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
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

  it('coerces DONE to AWAITING_APPROVAL when runner metadata signals skipApproval=false', async () => {
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
            number: 9,
            title: 'Implement',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner: {
        async run() {
          return {
            result: 'PR is open.\nDONE',
            model: 'test-model',
            cli: 'test-cli',
            metadata: { skipApproval: false },
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    if (result.status === 'processed') {
      expect(result.sentinel).toBe('AWAITING_APPROVAL');
      expect(result.nextStage).toBe('awaiting-approval');
    }

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"sentinel":"AWAITING_APPROVAL"');
    expect(events).toContain('"rawSentinel":"DONE"');
  });

  it('does not coerce DONE when runner metadata signals skipApproval=true', async () => {
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
            number: 9,
            title: 'Refine',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner: {
        async run() {
          return {
            result: 'Plan complete.\nDONE',
            model: 'test-model',
            cli: 'test-cli',
            metadata: { skipApproval: true },
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    if (result.status === 'processed') {
      expect(result.sentinel).toBe('DONE');
    }
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

  it('stamps resolved runner routing into run records and completion events', async () => {
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
            number: 110,
            title: 'Route stamp',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:00.000Z'),
      }),
      runner: {
        async run() {
          return {
            result: 'Fake runner completed\nDONE',
            model: 'test-model',
            cli: 'test-cli',
            routing: {
              runnerName: 'fake-light',
              runnerKind: 'fake',
              tier: 'light',
              reason: 'stage queue tier light selected runner fake-light',
            },
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const [runRecord] = await store.listRunRecords();
    expect(runRecord?.routing).toEqual({
      runnerName: 'fake-light',
      runnerKind: 'fake',
      tier: 'light',
      reason: 'stage queue tier light selected runner fake-light',
    });

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    expect(events).toContain('"routing":{"runnerName":"fake-light","runnerKind":"fake","tier":"light"');
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
    expect(events).toContain('"sourceEventType":"ticket.reply.published"');
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
                  isPullRequest: false,
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
              },
            },
          ];
        },
      },
      runner: {
        async run() {
          callCount += 1;
          return { result: 'Need more detail\nBLOCKED', model: 'test-model', cli: 'test-cli', session_id: 'session-2' };
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
        labels: ['wake:implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/14',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:implement'];

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
          return {
            result: [
              'Implemented. The previous CI run FAILED, but this one passed.',
              '',
              '```wake-result',
              '{ "status": "DONE" }',
              '```',
              'DONE',
            ].join('\n'),
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'session-3',
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();
    const runRecords = await store.listRunRecords();

    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.implement',
      'wake:status.completed',
      'wake:stage.done',
    ]);
    expect(runRecords[0]?.summary).toBe('Implemented. The previous CI run FAILED, but this one passed.');
    expect(runRecords[0]?.metadata).toMatchObject({
      envelope: 'structured',
    });
  });

  it('transitions to awaiting-approval and posts an approval request when a run requests sign-off', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];
    const publishedIntents: Array<{ kind: string; body: string }> = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#33',
      issue: {
        repo: 'atolis-hq/wake',
        number: 33,
        title: 'Approval Required Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/33',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'queue',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
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
          if (input.event.sourceEventType === 'wake.publish.intent.requested') {
            publishedIntents.push({
              kind: String(input.event.payload.kind),
              body: String(input.event.payload.body),
            });
          }
          return [];
        },
      },
      runner: {
        async run() {
          return {
            result: 'Issue is well-specified. Please reply with /approved to proceed.\nAWAITING_APPROVAL',
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'session-33',
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();
    const projection = await store.readIssueState('atolis-hq/wake', 33);

    expect(result.status).toBe('processed');
    expect((result as { sentinel?: string }).sentinel).toBe('AWAITING_APPROVAL');
    expect((result as { nextStage?: string }).nextStage).toBe('awaiting-approval');
    expect(projection?.wake.stage).toBe('awaiting-approval');
    expect(projection?.context.pendingApprovalAction).toBe('refine');
    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.refine',
      'wake:status.pending',
      'wake:stage.awaiting-approval',
    ]);
    expect(publishedIntents).toEqual([
      {
        kind: 'approval-request',
        body: 'Issue is well-specified. Please reply with /approved to proceed.',
      },
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
        isPullRequest: false,
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
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-approval',
        body: '/approved',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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

  it('stays idle when awaiting-approval and issue.updatedAt changed but no new human comment (Wake activity false-positive)', async () => {
    // Regression test: when Wake posts its approval-request comment, GitHub bumps
    // issue.updatedAt, causing needsWakeAction() to return true even though no
    // human has replied. The tick should return idle — not invoke the LLM.
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#32',
      issue: {
        repo: 'atolis-hq/wake',
        number: 32,
        title: 'Awaiting Approval Idle Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/32',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:06:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
  });

  it('invokes the agent when awaiting-approval and comment is an explicit /changes command (S2)', async () => {
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
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/31',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-feedback',
          body: '/changes Please revise section 3.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-feedback',
        body: '/changes Please revise section 3.',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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

  it('stays idle when awaiting-approval and the comment is conversation, not an /approved or /changes command (S2)', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#34',
      issue: {
        repo: 'atolis-hq/wake',
        number: 34,
        title: 'Approval Conversation Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/34',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-question',
          body: 'What does this change do exactly?',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-question',
        body: 'What does this change do exactly?',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
  });

  it('does not approve on a comment that merely mentions /approved as a substring (S2)', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#35',
      issue: {
        repo: 'atolis-hq/wake',
        number: 35,
        title: 'Approval Substring Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/35',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-not-approved',
          body: 'I have *not* /approved this yet, please wait.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-not-approved',
        body: 'I have *not* /approved this yet, please wait.',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'awaiting-approval',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
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
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
  });

  it('writes a failed run record, publishes failed labels, and posts a failure comment when workspace prep throws', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];
    const publishedIntents: Array<{ kind: string; body: string }> = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#20',
      issue: {
        repo: 'atolis-hq/wake',
        number: 20,
        title: 'Implement',
        body: 'Body',
        labels: ['wake:implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/20',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:implement'];

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
          if (input.event.sourceEventType === 'wake.publish.intent.requested') {
            publishedIntents.push({
              kind: String(input.event.payload.kind),
              body: String(input.event.payload.body),
            });
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
        async cleanupWorkspace() {},
      },
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect((result as { sentinel?: string }).sentinel).toBe('FAILED');
    expect((result as { nextStage?: string | null }).nextStage).toBeNull();
    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.implement',
      'wake:status.failed',
      'wake:stage.implement',
    ]);
    expect(publishedIntents).toHaveLength(1);
    expect(publishedIntents[0]!.kind).toBe('failure');
    expect(publishedIntents[0]!.body).toContain('git network failure');

    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');
    const completedEvent = events.split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
      .find((e: { payload?: { reason?: string } }) => e.payload?.reason === 'runner:infrastructure-error');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.payload.sentinel).toBe('FAILED');

    const runFiles = await readdir(join(root, 'runs'));
    const runRecord = JSON.parse(await readFile(join(root, 'runs', runFiles[0]!), 'utf8'));
    expect(runRecord.status).toBe('failed');
  });

  it('publishes a failed status label and failure comment when a run ends in FAILED', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];
    const publishedIntents: Array<{ kind: string; body: string }> = [];

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
        isPullRequest: false,
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
          expectedEcho: { commentIds: [], labels: [] },
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
          if (input.event.sourceEventType === 'wake.publish.intent.requested') {
            publishedIntents.push({
              kind: String(input.event.payload.kind),
              body: String(input.event.payload.body),
            });
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
      'wake:stage.refine',
      'wake:status.failed',
      'wake:stage.refine',
    ]);
    expect(publishedIntents).toHaveLength(1);
    expect(publishedIntents[0]!.kind).toBe('failure');
    expect(publishedIntents[0]!.body).toContain('Nope');
  });

  it('does not retry a FAILED run when only Wake-driven issue.updatedAt changes arrive', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;
    let pollCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#121',
      issue: {
        repo: 'atolis-hq/wake',
        number: 121,
        title: 'Execute',
        body: 'Body',
        labels: ['wake:implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/121',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:implement'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          pollCount += 1;

          if (pollCount === 1) {
            return [];
          }

          return [
            {
              schemaVersion: 1,
              eventId: 'evt-issue-121-resync',
              workItemKey: 'atolis-hq/wake#121',
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.upsert',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber: 121,
                sourceUrl: 'https://example.test/issues/121',
              },
              occurredAt: '2026-07-05T12:01:00.000Z',
              ingestedAt: '2026-07-05T12:01:00.000Z',
              trigger: 'immediate',
              payload: {
                ticket: {
                  repo: 'atolis-hq/wake',
                  number: 121,
                  title: 'Execute',
                  body: 'Body',
                  labels: ['wake:implement'],
                  assignees: [],
                  isPullRequest: false,
                  state: 'open',
                  url: 'https://example.test/issues/121',
                  createdAt: '2026-07-05T12:00:00.000Z',
                  updatedAt: '2026-07-05T12:01:00.000Z',
                },
              },
            },
          ];
        },
      },
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'Execution failed\nFAILED', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const first = await tickRunner.runTick();
    const second = await tickRunner.runTick();
    const projection = await store.readIssueState('atolis-hq/wake', 121);

    expect(first.status).toBe('processed');
    expect((first as { sentinel?: string }).sentinel).toBe('FAILED');
    expect(projection?.wake.stage).toBe('implement');
    expect(second.status).toBe('idle');
    expect(runnerCallCount).toBe(1);
  });

  it('retries the last action for a blocked issue with an unhandled human reply', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake'];
    let actionSeen = '';

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#122',
      issue: {
        repo: 'atolis-hq/wake',
        number: 122,
        title: 'Execute',
        body: 'Body',
        labels: ['wake'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/122',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-owner',
          body: 'Here is the missing detail.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-owner',
        body: 'Here is the missing detail.',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'blocked',
        lastRunId: 'run-122-1',
        syncedAt: '2026-07-05T12:05:00.000Z',
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastHandledCommentId: 'c-bot-question',
        lastRunAction: 'implement',
        lastRunSentinel: 'BLOCKED',
      },
    });

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run(input) {
          actionSeen = input.action;
          return { result: 'Implemented\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();
    const projection = await store.readIssueState('atolis-hq/wake', 122);

    expect(result.status).toBe('processed');
    expect(actionSeen).toBe('implement');
    expect(projection?.context.lastHandledCommentId).toBe('c-owner');
  });

  it('marks stale running run records failed during a later tick', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake'];
    const claudeHaikuEntry = config.runners['claude-haiku'];
    if (claudeHaikuEntry?.kind === 'claude') {
      claudeHaikuEntry.timeoutMs = 60_000;
    }
    config.tiers.light = ['claude-haiku'];
    config.tiers.standard = ['claude-haiku'];
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#123',
      issue: {
        repo: 'atolis-hq/wake',
        number: 123,
        title: 'Stale run',
        body: 'Body',
        labels: ['wake'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/123',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        lastRunId: 'run-123-stale',
        syncedAt: '2026-07-05T12:00:00.000Z',
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-123-stale',
      repo: 'atolis-hq/wake',
      issueNumber: 123,
      action: 'implement',
      status: 'running',
      startedAt: '2026-07-05T12:00:00.000Z',
    });

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:02:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'Should not run\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();
    const runRecord = await store.readRunRecord('run-123-stale');
    const projection = await store.readIssueState('atolis-hq/wake', 123);
    const events = await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8');

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
    expect(runRecord?.status).toBe('failed');
    expect(runRecord?.sentinel).toBe('FAILED');
    expect(projection?.wake.stage).toBe('implement');
    expect(events).toContain('"eventId":"run-123-stale-stale-reconciled"');
    expect(events).toContain('"sourceEventType":"wake.labels.requested"');
    expect(events).toContain('"stageLabel":"wake:stage.implement"');
  });

  it('pauses until the reported quota reset and suppresses quota failure comments', async () => {
    const store = createStateStore({ wakeRoot: root });
    const publishedKinds: string[] = [];
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-07T22:30:00.000Z') },
      config,
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [{
          repo: 'atolis-hq/wake', number: 112, title: 'Quota pause', body: '',
          labels: ['wake:queue'], comments: [],
        }],
      }),
      outboundSink: {
        async deliverIntent({ event }) {
          if (event.sourceEventType === 'wake.publish.intent.requested') {
            publishedKinds.push(String(event.payload.kind));
          }
          return [];
        },
      },
      runner: {
        async run() {
          return {
            result: "Claude runner failed: You've hit your session limit - resets 1:10am (UTC)\nFAILED",
            model: 'test-model',
            cli: 'Claude',
            failureClass: 'quota' as const,
          };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(await store.readLedger()).toMatchObject({
      runners: {
        fake: {
          pausedUntil: '2026-07-08T01:10:00.000Z',
          failureCount: 1,
        },
      },
    });
    expect(publishedKinds).toEqual([]);
    const projection = await store.readIssueState('atolis-hq/wake', 112);
    expect(projection?.context.lastFailureClass).toBe('quota');
  });

  it('supersedes a stale running record when the item has already completed a newer run', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    const claudeHaikuEntry = config.runners['claude-haiku'];
    if (claudeHaikuEntry?.kind === 'claude') {
      claudeHaikuEntry.timeoutMs = 60_000;
    }
    config.tiers.light = ['claude-haiku'];
    config.tiers.standard = ['claude-haiku'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#124',
      issue: {
        repo: 'atolis-hq/wake', number: 124, title: 'Recovered run', body: '',
        labels: ['wake'], assignees: [], isPullRequest: false, state: 'open',
        url: 'https://example.test/issues/124',
        createdAt: '2026-07-05T12:00:00.000Z', updatedAt: '2026-07-05T12:01:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'done', lastRunId: 'run-124-new', syncedAt: '2026-07-05T12:01:00.000Z',
        stageHistory: [], recentEventIds: [], expectedEcho: { commentIds: [], labels: [] },
      },
      context: { lastRunAction: 'implement', lastRunSentinel: 'DONE' },
    });
    await store.writeRunRecord({
      schemaVersion: 1, runId: 'run-124-stale', repo: 'atolis-hq/wake', issueNumber: 124,
      action: 'implement', status: 'running', startedAt: '2026-07-05T12:00:00.000Z',
    });
    await store.writeRunRecord({
      schemaVersion: 1, runId: 'run-124-new', repo: 'atolis-hq/wake', issueNumber: 124,
      action: 'implement', status: 'completed', startedAt: '2026-07-05T12:00:30.000Z',
      finishedAt: '2026-07-05T12:01:00.000Z', sentinel: 'DONE',
    });

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:02:00.000Z') },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: { async run() { throw new Error('should not run'); } },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();
    const staleRecord = await store.readRunRecord('run-124-stale');
    const projection = await store.readIssueState('atolis-hq/wake', 124);

    expect(result.status).toBe('idle');
    expect(staleRecord?.status).toBe('superseded');
    expect(projection?.wake.stage).toBe('done');
    expect(await store.readEventEnvelope('run-124-stale-stale-reconciled')).toBeNull();
  });

  it('deletes the per-issue workspace and clears workspacePath when an issue is closed', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', 'atolis-hq__wake', '200');
    await mkdir(workspacePath, { recursive: true });

    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#200',
      issue: {
        repo: 'atolis-hq/wake',
        number: 200,
        title: 'Closed issue with workspace',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'closed',
        url: 'https://example.test/atolis-hq/wake/issues/200',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      comments: [],
      wake: {
        stage: 'done',
        workspacePath,
        syncedAt: nowIso,
        stageHistory: [{ stage: 'done', changedAt: nowIso, reason: 'test' }],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    const tickRunner = createTickRunner({
      clock: { now: () => new Date(nowIso) },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: { async run() { return { result: 'DONE', model: 'test', cli: 'test' }; } },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    await expect(access(workspacePath)).rejects.toThrow();
    const updatedProjection = await store.readIssueState('atolis-hq/wake', 200);
    expect(updatedProjection?.wake.workspacePath).toBeUndefined();
  });

  it('does not delete the canonical clone when a closed issue has a read-only workspace path', async () => {
    const store = createStateStore({ wakeRoot: root });
    const canonicalClonePath = join(root, 'repos', 'atolis-hq__wake');
    await mkdir(canonicalClonePath, { recursive: true });

    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#201',
      issue: {
        repo: 'atolis-hq/wake',
        number: 201,
        title: 'Closed refine-only issue',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'closed',
        url: 'https://example.test/atolis-hq/wake/issues/201',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      comments: [],
      wake: {
        stage: 'implement',
        workspacePath: canonicalClonePath,
        syncedAt: nowIso,
        stageHistory: [{ stage: 'implement', changedAt: nowIso, reason: 'test' }],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const config = createDefaultWakeConfig(root);
    const tickRunner = createTickRunner({
      clock: { now: () => new Date(nowIso) },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: { async run() { return { result: 'DONE', model: 'test', cli: 'test' }; } },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    await expect(access(canonicalClonePath)).resolves.toBeUndefined();
    const updatedProjection = await store.readIssueState('atolis-hq/wake', 201);
    expect(updatedProjection?.wake.workspacePath).toBe(canonicalClonePath);
  });

  it('records cleanup failure and continues dispatching eligible work', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', 'atolis-hq__wake', '202');
    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#202',
      issue: {
        repo: 'atolis-hq/wake', number: 202, title: 'Locked workspace', body: '',
        labels: [], assignees: [], isPullRequest: false, state: 'closed',
        url: 'https://example.test/issues/202', createdAt: nowIso, updatedAt: nowIso,
      },
      comments: [],
      wake: {
        stage: 'done', workspacePath, syncedAt: nowIso, stageHistory: [],
        recentEventIds: [], expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];
    const fakeWorkspace = createFakeWorkspaceManager(join(root, 'workspaces'));
    const tickRunner = createTickRunner({
      clock: { now: () => new Date(nowIso) },
      config,
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [{
          repo: 'atolis-hq/wake', number: 203, title: 'Runnable', body: '',
          labels: ['wake:queue'], comments: [],
        }],
      }),
      runner: { async run() { return { result: 'Refined\nDONE', model: 'test', cli: 'test' }; } },
      workspaceManager: {
        ...fakeWorkspace,
        async cleanupWorkspace() { throw new Error('EPERM: workspace is locked'); },
      },
    });

    const result = await tickRunner.runTick();
    const events = await store.listEventEnvelopes();

    expect(result.status).toBe('processed');
    expect(events.some((event) =>
      event.sourceEventType === 'wake.workspace.cleanup-failed' &&
      event.workItemKey === 'github:atolis-hq/wake#202' &&
      event.payload.error === 'EPERM: workspace is locked'
    )).toBe(true);
  });

  it('does not overwrite a completed run record when outbound delivery fails (S1)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [{
          repo: 'atolis-hq/wake', number: 40, title: 'Delivery failure', body: '',
          labels: ['wake:queue'], comments: [],
        }],
      }),
      outboundSink: {
        async deliverIntent() {
          throw new Error('GitHub 503');
        },
      },
      runner: {
        async run() {
          return { result: 'Refined\nDONE', model: 'test-model', cli: 'test-cli', session_id: 'session-40' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect((result as { sentinel?: string }).sentinel).toBe('DONE');

    const runRecords = await store.listRunRecords();
    expect(runRecords).toHaveLength(1);
    expect(runRecords[0]?.status).toBe('completed');
    expect(runRecords[0]?.sentinel).toBe('DONE');

    const events = await store.listEventEnvelopes();
    const completedEvents = events.filter((e) => e.sourceEventType === 'wake.run.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload.sentinel).toBe('DONE');

    const deliveryFailures = events.filter((e) => e.sourceEventType === 'wake.publish.failed');
    expect(deliveryFailures.length).toBeGreaterThan(0);
    expect(deliveryFailures[0]?.payload.error).toBe('GitHub 503');
  });

  it('retries an unconfirmed outbound intent from a prior tick and dead-letters after max attempts (E5)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    let deliverAttempts = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#41',
      issue: {
        repo: 'atolis-hq/wake', number: 41, title: 'Outbox retry', body: '',
        labels: [], assignees: [], isPullRequest: false, state: 'open',
        url: 'https://example.test/issues/41',
        createdAt: '2026-07-05T12:00:00.000Z', updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'blocked', syncedAt: '2026-07-05T12:00:00.000Z',
        stageHistory: [], recentEventIds: [], expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const orphanedIntent = {
      schemaVersion: 1 as const,
      eventId: 'run-41-publish-intent',
      workItemKey: 'atolis-hq/wake#41',
      streamScope: 'work-item' as const,
      direction: 'outbound' as const,
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.intent.requested',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 41, runId: 'run-41' },
      occurredAt: '2026-07-05T11:00:00.000Z',
      ingestedAt: '2026-07-05T11:00:00.000Z',
      trigger: 'context-only' as const,
      payload: { kind: 'question', body: 'What should happen here?', action: 'refine', runId: 'run-41' },
    };
    await store.appendEventEnvelope(orphanedIntent);

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      outboundSink: {
        async deliverIntent() {
          deliverAttempts += 1;
          throw new Error('still down');
        },
      },
      runner: { async run() { throw new Error('should not run'); } },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();
    await tickRunner.runTick();
    await tickRunner.runTick();
    await tickRunner.runTick();

    expect(deliverAttempts).toBe(3);

    const events = await store.listEventEnvelopes();
    const failures = events.filter((e) => e.sourceEventType === 'wake.publish.failed');
    expect(failures).toHaveLength(3);
  });

  it('does not consume the triggering comment on an infra failure, so the next tick retries it (S9)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];
    let runnerCallCount = 0;
    let prepareCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#50',
      issue: {
        repo: 'atolis-hq/wake', number: 50, title: 'Infra blip', body: '',
        labels: ['wake:queue'], assignees: [], isPullRequest: false, state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-05T12:00:00.000Z', updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [
        {
          id: 'c-trigger', body: 'Please pick this up.', author: { login: 'owner' },
          createdAt: '2026-07-05T12:00:00.000Z', updatedAt: '2026-07-05T12:00:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-trigger', body: 'Please pick this up.', author: { login: 'owner' },
        createdAt: '2026-07-05T12:00:00.000Z', updatedAt: '2026-07-05T12:00:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'queue', stageHistory: [], recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z', expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
    });

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'Refined\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: {
        async prepareWorkspace() { return { workspacePath: 'unused' }; },
        async prepareReadOnlyClone() {
          prepareCallCount += 1;
          if (prepareCallCount === 1) {
            throw new Error('git network failure');
          }
          return { workspacePath: 'unused' };
        },
        async cleanupWorkspace() {},
      },
    });

    const first = await tickRunner.runTick();
    expect(first.status).toBe('processed');
    expect((first as { sentinel?: string }).sentinel).toBe('FAILED');
    expect(runnerCallCount).toBe(0);

    const afterFirst = await store.readIssueState('atolis-hq/wake', 50);
    expect(afterFirst?.context.lastHandledCommentId).toBeUndefined();
    expect(afterFirst?.context.lastFailureClass).toBe('infra');

    const second = await tickRunner.runTick();
    expect(second.status).toBe('processed');
    expect(runnerCallCount).toBe(1);
  });
});
