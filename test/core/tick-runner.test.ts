import { beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createResourceIndex } from '../../src/adapters/fs/resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { CORRELATION_PRIMARY_CONFLICT_EVENT, CORRELATION_REGISTERED_EVENT } from '../../src/domain/schema.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';

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
        const runFiles = (await readdir(join(root, 'runs'))).filter((file) => file.endsWith('.json'));
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    if (result.status === 'processed') {
      expect(result.sentinel).toBe('AWAITING_APPROVAL');
      expect(result.nextStage).toBeNull();
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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

  it('sets awaiting-approval status and posts an approval request when a run requests sign-off', async () => {
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();
    const projection = await store.readIssueState('atolis-hq/wake', 33);

    expect(result.status).toBe('processed');
    expect((result as { sentinel?: string }).sentinel).toBe('AWAITING_APPROVAL');
    expect((result as { nextStage?: string | null }).nextStage).toBeNull();
    expect(projection?.wake.stage).toBe('refine');
    expect(projection?.context.pendingApprovalAction).toBe('refine');
    expect(projection?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
    expect(deliveredEvents).toEqual([
      'wake:status.working',
      'wake:stage.refine',
      'wake:status.awaiting-approval',
      'wake:stage.refine',
    ]);
    expect(publishedIntents).toEqual([
      {
        kind: 'approval-request',
        body: 'Issue is well-specified. Please reply with /approved to proceed.',
      },
    ]);
  });

  it('transitions an awaiting-approval status to done when /approved comment is present', async () => {
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
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
      },
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect((result as { nextStage?: string }).nextStage).toBe('done');
    expect(runnerCallCount).toBe(0);
    expect(deliveredEvents).toContain('wake:stage.done');
  });

  it('stays idle when awaiting approval and issue.updatedAt changed but no new human comment (Wake activity false-positive)', async () => {
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
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
      },
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
  });

  it('invokes the agent when awaiting approval and comment is an explicit /changes command (S2)', async () => {
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
        stage: 'refine',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'refine',
      },
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(runnerCallCount).toBe(1);
  });

  it('invokes the agent when awaiting approval and comment is an explicit /question command', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#33',
      issue: {
        repo: 'atolis-hq/wake',
        number: 33,
        title: 'Approval Question Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/33',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'c-question',
          body: '/question What changed in the implementation?',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-question',
        body: '/question What changed in the implementation?',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      },
      wake: {
        stage: 'refine',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
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
        async run(input) {
          runnerCallCount += 1;
          expect(input.action).toBe('refine');
          return { result: 'The implementation updates the parser only.\nAWAITING_APPROVAL', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(runnerCallCount).toBe(1);
  });

  it('stays idle when awaiting approval and the comment is conversation, not an explicit command (S2)', async () => {
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
        stage: 'refine',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'refine',
      },
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
  });

  it('marks synced approval replies pending before the next item is claimed', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: Array<{ issueNumber: number | undefined; statusLabel: string; stageLabel: string }> = [];
    let runnerCallCount = 0;

    for (const issueNumber of [41, 42]) {
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: `atolis-hq/wake#${issueNumber}`,
        issue: {
          repo: 'atolis-hq/wake',
          number: issueNumber,
          title: `Approval ${issueNumber}`,
          body: 'Body',
          labels: ['wake:queue', 'wake:status.awaiting-approval', 'wake:stage.implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: `https://example.test/issues/${issueNumber}`,
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
        context: {
          lastRunSentinel: 'AWAITING_APPROVAL',
          pendingApprovalAction: 'implement',
        },
        correlatedResources: [],
      });
    }

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [41, 42].map((issueNumber) => ({
            schemaVersion: 1 as const,
            eventId: `evt-comment-${issueNumber}`,
            workItemKey: `atolis-hq/wake#${issueNumber}`,
            streamScope: 'work-item' as const,
            direction: 'inbound' as const,
            sourceSystem: 'github',
            sourceEventType: 'ticket.comment.created',
            sourceRefs: {
              repo: 'atolis-hq/wake',
              issueNumber,
              commentId: `c-${issueNumber}`,
            },
            occurredAt: '2026-07-05T12:09:00.000Z',
            ingestedAt: '2026-07-05T12:09:00.000Z',
            trigger: 'context-only' as const,
            payload: {
              comment: {
                id: `c-${issueNumber}`,
                body: issueNumber === 41 ? '/approved' : '/changes Please adjust this.',
                author: { login: 'owner' },
                createdAt: '2026-07-05T12:09:00.000Z',
                updatedAt: '2026-07-05T12:09:00.000Z',
              },
            },
          }));
        },
      },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.labels.requested') {
            deliveredEvents.push({
              issueNumber: input.event.sourceRefs.issueNumber,
              statusLabel: String(input.event.payload.statusLabel),
              stageLabel: String(input.event.payload.stageLabel),
            });
          }
          return [];
        },
      },
      runner: {
        async run() {
          runnerCallCount += 1;
          return { result: 'Revised.\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(deliveredEvents).toContainEqual({
      issueNumber: 41,
      statusLabel: 'wake:status.pending',
      stageLabel: 'wake:stage.implement',
    });
    expect(deliveredEvents).toContainEqual({
      issueNumber: 42,
      statusLabel: 'wake:status.pending',
      stageLabel: 'wake:stage.implement',
    });
    expect(deliveredEvents).toContainEqual({
      issueNumber: 41,
      statusLabel: 'wake:status.completed',
      stageLabel: 'wake:stage.done',
    });
    expect(runnerCallCount).toBe(0);
  });

  it('does not mark synced approval-thread conversation pending', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: string[] = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#43',
      issue: {
        repo: 'atolis-hq/wake',
        number: 43,
        title: 'Approval Conversation Sync',
        body: 'Body',
        labels: ['wake:queue', 'wake:status.awaiting-approval', 'wake:stage.implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/43',
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
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
      },
      correlatedResources: [],
    });

    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [{
            schemaVersion: 1 as const,
            eventId: 'evt-comment-43',
            workItemKey: 'atolis-hq/wake#43',
            streamScope: 'work-item' as const,
            direction: 'inbound' as const,
            sourceSystem: 'github',
            sourceEventType: 'ticket.comment.created',
            sourceRefs: {
              repo: 'atolis-hq/wake',
              issueNumber: 43,
              commentId: 'c-43',
            },
            occurredAt: '2026-07-05T12:09:00.000Z',
            ingestedAt: '2026-07-05T12:09:00.000Z',
            trigger: 'context-only' as const,
            payload: {
              comment: {
                id: 'c-43',
                body: 'What is included in this change?',
                author: { login: 'owner' },
                createdAt: '2026-07-05T12:09:00.000Z',
                updatedAt: '2026-07-05T12:09:00.000Z',
              },
            },
          }];
        },
      },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.labels.requested') {
            deliveredEvents.push(String(input.event.payload.statusLabel));
          }
          return [];
        },
      },
      runner: {
        async run() {
          throw new Error('should not run');
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('idle');
    expect(deliveredEvents).toEqual([]);
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
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'AWAITING_APPROVAL',
        pendingApprovalAction: 'implement',
      },
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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

    const runFiles = (await readdir(join(root, 'runs'))).filter((file) => file.endsWith('.json'));
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
        stage: 'implement',
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
    const transcriptPath = join(root, 'transcripts', 'atolis-hq__wake', '200', 'run-200-1', 'run-200-1.codex.implement.prompt.txt');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(root, 'transcripts', 'atolis-hq__wake', '200', 'run-200-1'), { recursive: true });
    await writeFile(transcriptPath, 'raw prompt', 'utf8');

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
      correlatedResources: [],
    });

    const config = createDefaultWakeConfig(root);
    const tickRunner = createTickRunner({
      clock: { now: () => new Date(nowIso) },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: { async run() { return { result: 'DONE', model: 'test', cli: 'test' }; } },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    await expect(access(workspacePath)).rejects.toThrow();
    await expect(access(transcriptPath)).rejects.toThrow();
    const updatedProjection = await store.readIssueState('atolis-hq/wake', 200);
    expect(updatedProjection?.wake.workspacePath).toBeUndefined();
  });

  it('retains transcripts for closed workspace cleanup when configured', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', 'atolis-hq__wake', '204');
    const transcriptPath = join(root, 'transcripts', 'atolis-hq__wake', '204', 'run-204-1', 'run-204-1.codex.implement.prompt.txt');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(root, 'transcripts', 'atolis-hq__wake', '204', 'run-204-1'), { recursive: true });
    await writeFile(transcriptPath, 'raw prompt', 'utf8');

    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: 'atolis-hq/wake#204',
      issue: {
        repo: 'atolis-hq/wake',
        number: 204,
        title: 'Closed issue with retained transcripts',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'closed',
        url: 'https://example.test/atolis-hq/wake/issues/204',
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
      correlatedResources: [],
    });

    const config = createDefaultWakeConfig(root);
    config.transcripts.retainAfterWorkspaceCleanup = true;
    const tickRunner = createTickRunner({
      clock: { now: () => new Date(nowIso) },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: { async run() { return { result: 'DONE', model: 'test', cli: 'test' }; } },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    await expect(access(workspacePath)).rejects.toThrow();
    await expect(readFile(transcriptPath, 'utf8')).resolves.toBe('raw prompt');
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
      correlatedResources: [],
    });

    const config = createDefaultWakeConfig(root);
    const tickRunner = createTickRunner({
      clock: { now: () => new Date(nowIso) },
      config,
      stateStore: store,
      workSource: { async pollEvents() { return []; } },
      runner: { async run() { return { result: 'DONE', model: 'test', cli: 'test' }; } },
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
      resourceIndex: createFakeResourceIndex(),
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
        stage: 'implement', syncedAt: '2026-07-05T12:00:00.000Z',
        stageHistory: [], recentEventIds: [], expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
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
      correlatedResources: [],
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
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: {
        async prepareWorkspace() { return { workspacePath: 'unused', mergeConflictDetected: false }; },
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

  it('auto-registers the originating ticket as a correlated resource on first sight, once', async () => {
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
            number: 60,
            title: 'Auto register',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:00.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const projection = await store.readIssueState('atolis-hq/wake', 60);
    expect(projection?.correlatedResources).toEqual([
      {
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#60',
        role: 'representation',
        relation: 'primary',
        provenance: 'wake-created',
        registeredAt: '2026-07-05T12:00:00.000Z',
      },
    ]);

    const registrationEvents = (await store.listEventEnvelopes()).filter(
      (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
    );
    expect(registrationEvents).toHaveLength(1);

    // A second tick over the same, already-registered ticket must not
    // append a duplicate registration.
    await tickRunner.runTick();
    const registrationEventsAfterSecondTick = (await store.listEventEnvelopes()).filter(
      (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
    );
    expect(registrationEventsAfterSecondTick).toHaveLength(1);
  });

  it('fix E: does not resurrect a deliberate retraction — a work item that retracted all its resources is not re-auto-registered', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];
    const resourceIndex = createFakeResourceIndex();

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 61,
            title: 'Retract then re-tick',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:00.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex,
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    // First tick auto-registers the origin ticket.
    await tickRunner.runTick();
    const registeredBefore = (await store.listEventEnvelopes()).filter(
      (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
    );
    expect(registeredBefore).toHaveLength(1);

    // The operator (or a later `wake correlate` command) deliberately
    // retracts the only correlated resource, leaving correlatedResources[]
    // legitimately empty — this must be durable, not just a transient state
    // that the next tick silently reverses.
    const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex });
    const retraction = createEventEnvelope({
      eventId: 'wake-61-origin-retracted',
      workItemKey: 'fake-ticketing:atolis-hq/wake#61',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.correlation.retracted',
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 61 },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:00.000Z',
      trigger: 'context-only',
      payload: { resourceUri: 'fake-ticketing:issue:atolis-hq/wake#61' },
    });
    await store.appendEventEnvelope(retraction);
    await projectionUpdater.rebuildFromEvents([retraction]);

    const afterRetraction = await store.readIssueState('atolis-hq/wake', 61);
    expect(afterRetraction?.correlatedResources).toEqual([]);

    // A later tick must not treat the now-empty correlatedResources[] as
    // "never registered" and silently re-claim the origin uri as primary
    // (finding E) — the length-based check this replaces would fail here.
    await tickRunner.runTick();

    const registeredAfter = (await store.listEventEnvelopes()).filter(
      (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
    );
    expect(registeredAfter).toHaveLength(1);

    const finalProjection = await store.readIssueState('atolis-hq/wake', 61);
    expect(finalProjection?.correlatedResources).toEqual([]);
  });

  it('reproduces projections and the resource index exactly after deleting state/ and replaying events/ (ADR 0001 rebuild guarantee)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createResourceIndex({ paths: store.paths });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      resourceIndex,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 70,
            title: 'Rebuild target',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:00.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    // First tick auto-registers the origin ticket as a correlated resource.
    await tickRunner.runTick();

    // Simulate additional correlated resources being discovered (e.g. an
    // implementation PR) via the same fold + index machinery a later
    // `wake correlate` command will drive, sharing the exact stateStore +
    // resourceIndex instances the tick runner uses.
    const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex });
    const prRegistration = createEventEnvelope({
      eventId: 'wake-70-pr-registered',
      workItemKey: 'fake-ticketing:atolis-hq/wake#70',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 70, resourceUri: 'github:pr:atolis-hq/wake#71' },
      occurredAt: '2026-07-05T12:05:00.000Z',
      ingestedAt: '2026-07-05T12:05:00.000Z',
      trigger: 'context-only',
      payload: {
        resourceUri: 'github:pr:atolis-hq/wake#71',
        role: 'implementation',
        relation: 'primary',
        provenance: 'agent-reported',
      },
    });
    await store.appendEventEnvelope(prRegistration);
    await projectionUpdater.rebuildFromEvents([prRegistration]);

    // A second, unrelated work item now shows up and tries to claim the same
    // PR as its own primary — this must fold to a *real* secondary (a
    // registration on a uri another work item already holds as primary),
    // never an orphan one, and must record a primary-conflict event naming
    // the incumbent (ADR 0001 §6). This is also the conflict path that
    // appends an event mid-fold, which is exactly where replay divergence
    // would hide, so the rebuild guarantee below must hold across it too.
    const secondIssueUpsert = createEventEnvelope({
      eventId: 'fake-issue-atolis-hq-wake-90',
      workItemKey: 'fake-ticketing:atolis-hq/wake#90',
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'fake-ticketing',
      sourceEventType: 'fake.issue.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 90,
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#90',
      },
      occurredAt: '2026-07-05T12:07:00.000Z',
      ingestedAt: '2026-07-05T12:07:00.000Z',
      trigger: 'immediate',
      payload: {
        issue: {
          repo: 'atolis-hq/wake',
          number: 90,
          title: 'Conflicting claimant',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          state: 'open',
          url: 'https://example.test/atolis-hq/wake/issues/90',
          createdAt: '2026-07-05T12:07:00.000Z',
          updatedAt: '2026-07-05T12:07:00.000Z',
        },
      },
    });
    const conflictingRegistration = createEventEnvelope({
      eventId: 'wake-90-pr-conflict-registered',
      workItemKey: 'fake-ticketing:atolis-hq/wake#90',
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 90, resourceUri: 'github:pr:atolis-hq/wake#71' },
      occurredAt: '2026-07-05T12:08:00.000Z',
      ingestedAt: '2026-07-05T12:08:00.000Z',
      trigger: 'context-only',
      payload: {
        resourceUri: 'github:pr:atolis-hq/wake#71',
        role: 'implementation',
        relation: 'primary',
        provenance: 'agent-reported',
      },
    });

    for (const event of [secondIssueUpsert, conflictingRegistration]) {
      await store.appendEventEnvelope(event);
      await projectionUpdater.rebuildFromEvents([event]);
    }

    const beforeIncumbent = await store.readIssueState('atolis-hq/wake', 70);
    expect(beforeIncumbent?.correlatedResources.length ?? 0).toBeGreaterThanOrEqual(2);

    const beforeClaimant = await store.readIssueState('atolis-hq/wake', 90);
    expect(beforeClaimant?.correlatedResources).toEqual([
      {
        resourceUri: 'github:pr:atolis-hq/wake#71',
        role: 'implementation',
        relation: 'secondary',
        provenance: 'agent-reported',
        registeredAt: '2026-07-05T12:08:00.000Z',
      },
    ]);
    expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#71')).toBe(
      'fake-ticketing:atolis-hq/wake#70',
    );

    const beforeAllEvents = await store.listEventEnvelopes();
    const conflictEventCountBefore = beforeAllEvents.filter(
      (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT,
    ).length;
    expect(conflictEventCountBefore).toBe(1);

    const indexDir = join(root, 'state', 'index');
    const shardFilesBefore = (await readdir(indexDir)).sort();
    expect(shardFilesBefore.length).toBeGreaterThanOrEqual(1);
    const shardSnapshots = new Map<string, string>();
    for (const file of shardFilesBefore) {
      shardSnapshots.set(file, await readFile(join(indexDir, file), 'utf8'));
    }

    // Delete state/ entirely — the projection AND the index are both
    // rebuildable projections over events/, never source of truth.
    await rm(join(root, 'state'), { recursive: true, force: true });

    const allEvents = await store.listEventEnvelopes();
    await projectionUpdater.rebuildFromEvents(allEvents);

    const afterIncumbent = await store.readIssueState('atolis-hq/wake', 70);
    expect(afterIncumbent).toEqual(beforeIncumbent);

    const afterClaimant = await store.readIssueState('atolis-hq/wake', 90);
    expect(afterClaimant).toEqual(beforeClaimant);

    const shardFilesAfter = (await readdir(indexDir)).sort();
    expect(shardFilesAfter).toEqual(shardFilesBefore);
    for (const file of shardFilesAfter) {
      expect(await readFile(join(indexDir, file), 'utf8')).toBe(shardSnapshots.get(file));
    }

    const afterAllEvents = await store.listEventEnvelopes();
    const conflictEventCountAfter = afterAllEvents.filter(
      (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT,
    ).length;
    expect(conflictEventCountAfter).toBe(conflictEventCountBefore);
  });
});
