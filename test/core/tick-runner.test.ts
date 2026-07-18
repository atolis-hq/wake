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
import {
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from '../../src/domain/schema.js';
import type { IssueStateRecord } from '../../src/domain/types.js';
import { createEventEnvelope } from '../../src/lib/event-log.js';
import { isWorkId } from '../../src/lib/work-id.js';

/**
 * A stable, ULID-shaped work id per issue number, for fixtures that seed a
 * projection directly rather than letting the resolver mint one. Real ids come
 * from createWorkId() and are read back off the projection.
 */
function workId(issueNumber: number): string {
  return `work-01JZ${String(issueNumber).padStart(22, '0')}`;
}

function githubIssueUri(issueNumber: number): string {
  return `github:issue:atolis-hq/wake#${issueNumber}`;
}

/**
 * Test-only lookup of a projection by the ticket it represents, for assertions
 * that are naturally written against an issue number rather than an opaque work
 * id. Production never does this: it resolves the ticket's uri through the
 * resource index in one shard read (spec D2). A scan is fine here — fixtures
 * hold a handful of projections — but it must not creep back into src/.
 */
async function findByIssueRef(
  store: ReturnType<typeof createStateStore>,
  input: { repo: string; issueNumber: number },
): Promise<IssueStateRecord | null> {
  const candidates = await store.listIssueStates({ includeArchived: true });
  return (
    candidates.find(
      (record) => record.issue.repo === input.repo && record.issue.number === input.issueNumber,
    ) ?? null
  );
}

/**
 * A resource index already holding the origin-ticket registrations an earlier
 * tick's mint would have written. Fixtures that seed a projection *and* poll
 * events for the same ticket need this: without the index entry the resolver
 * correctly treats the ticket as unseen and mints a second work item, because
 * a miss means "mint" and nothing else.
 */
async function seededResourceIndex(issueNumbers: number[]) {
  const resourceIndex = createFakeResourceIndex();
  for (const issueNumber of issueNumbers) {
    await resourceIndex.register(githubIssueUri(issueNumber), workId(issueNumber));
  }
  return resourceIndex;
}

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
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.upsert',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber: 12,
                sourceUrl: 'https://github.com/atolis-hq/wake/issues/12',
                resourceUri: githubIssueUri(12),
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
              streamScope: 'work-item',
              direction: 'inbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.comment.created',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber: 12,
                commentId: 'c-1',
                resourceUri: githubIssueUri(12),
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
      workItemKey: workId(14),
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
      workItemKey: workId(33),
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
    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 33 });

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
      workItemKey: workId(30),
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
      workItemKey: workId(32),
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
      workItemKey: workId(31),
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
      workItemKey: workId(34),
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
        workItemKey: workId(issueNumber),
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
            streamScope: 'work-item' as const,
            direction: 'inbound' as const,
            sourceSystem: 'github',
            sourceEventType: 'ticket.comment.created',
            sourceRefs: {
              repo: 'atolis-hq/wake',
              issueNumber,
              commentId: `c-${issueNumber}`,
              resourceUri: githubIssueUri(issueNumber),
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
      // Both projections were minted by an earlier tick, so their origin
      // tickets already resolve; without these entries the resolver would
      // correctly mint a second work item for each.
      resourceIndex: await seededResourceIndex([41, 42]),
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
      workItemKey: workId(43),
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
            streamScope: 'work-item' as const,
            direction: 'inbound' as const,
            sourceSystem: 'github',
            sourceEventType: 'ticket.comment.created',
            sourceRefs: {
              repo: 'atolis-hq/wake',
              issueNumber: 43,
              commentId: 'c-43',
              resourceUri: githubIssueUri(43),
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
      resourceIndex: await seededResourceIndex([43]),
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
      workItemKey: workId(35),
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
      workItemKey: workId(20),
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
      workItemKey: workId(15),
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
      workItemKey: workId(121),
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
              streamScope: 'global-intake',
              direction: 'inbound',
              sourceSystem: 'github',
              sourceEventType: 'ticket.upsert',
              sourceRefs: {
                repo: 'atolis-hq/wake',
                issueNumber: 121,
                sourceUrl: 'https://example.test/issues/121',
                resourceUri: githubIssueUri(121),
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
      resourceIndex: await seededResourceIndex([121]),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const first = await tickRunner.runTick();
    const second = await tickRunner.runTick();
    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 121 });

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
      workItemKey: workId(122),
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
    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 122 });

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
      workItemKey: workId(123),
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
      workItemKey: workId(123),
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
    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 123 });
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

  // Identity proof, not a perf proof: the run record's repo/issueNumber are a
  // human-readable snapshot, never the way its work item is found. Here the
  // ticket has since moved repo (spec D3's motivating case — a GitHub transfer
  // assigns a new number in the target repo), so the projection is reachable
  // ONLY by the work id the record carries. Under a scan of `issue` snapshots
  // this run orphans and is wrongly superseded instead of reconciled.
  it('reconciles a stale run record through its workItemKey after the ticket moved repo', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake'];
    const claudeHaikuEntry = config.runners['claude-haiku'];
    if (claudeHaikuEntry?.kind === 'claude') {
      claudeHaikuEntry.timeoutMs = 60_000;
    }
    // Staleness uses the max timeout across runners active in tiers, so the
    // tiers must be pinned to the 60s runner for the run to read as stale.
    config.tiers.light = ['claude-haiku'];
    config.tiers.standard = ['claude-haiku'];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(300),
      issue: {
        repo: 'atolis-hq/wake-next',
        number: 900,
        title: 'Transferred',
        body: 'Body',
        labels: ['wake'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/900',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        lastRunId: 'run-300-stale',
        syncedAt: '2026-07-05T12:00:00.000Z',
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {},
      correlatedResources: [],
    });
    // The representation the run was launched against, before the transfer.
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-300-stale',
      workItemKey: workId(300),
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
          throw new Error('runner must not be invoked');
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const runRecord = await store.readRunRecord('run-300-stale');
    expect(runRecord?.status).toBe('failed');
    expect(runRecord?.sentinel).toBe('FAILED');
    expect(runRecord?.metadata?.reconciledBy).toBe('stale-running-record');

    const reconciled = await store.readEventEnvelope('run-300-stale-stale-reconciled');
    expect(reconciled?.workItemKey).toBe(workId(300));
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
    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 112 });
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
      workItemKey: workId(124),
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
      schemaVersion: 1, runId: 'run-124-stale', workItemKey: workId(124),
      repo: 'atolis-hq/wake', issueNumber: 124,
      action: 'implement', status: 'running', startedAt: '2026-07-05T12:00:00.000Z',
    });
    await store.writeRunRecord({
      schemaVersion: 1, runId: 'run-124-new', workItemKey: workId(124),
      repo: 'atolis-hq/wake', issueNumber: 124,
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
    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 124 });

    expect(result.status).toBe('idle');
    expect(staleRecord?.status).toBe('superseded');
    expect(projection?.wake.stage).toBe('done');
    expect(await store.readEventEnvelope('run-124-stale-stale-reconciled')).toBeNull();
  });

  it('deletes the per-issue workspace and clears workspacePath when an issue is closed', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', workId(200));
    const transcriptPath = join(root, 'transcripts', workId(200), 'run-200-1', 'run-200-1.codex.implement.prompt.txt');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(root, 'transcripts', workId(200), 'run-200-1'), { recursive: true });
    await writeFile(transcriptPath, 'raw prompt', 'utf8');

    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(200),
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
    const updatedProjection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 200 });
    expect(updatedProjection?.wake.workspacePath).toBeUndefined();
  });

  it('retains transcripts for closed workspace cleanup when configured', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', workId(204));
    const transcriptPath = join(root, 'transcripts', workId(204), 'run-204-1', 'run-204-1.codex.implement.prompt.txt');
    await mkdir(workspacePath, { recursive: true });
    await mkdir(join(root, 'transcripts', workId(204), 'run-204-1'), { recursive: true });
    await writeFile(transcriptPath, 'raw prompt', 'utf8');

    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(204),
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
      workItemKey: workId(201),
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
    const updatedProjection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 201 });
    expect(updatedProjection?.wake.workspacePath).toBe(canonicalClonePath);
  });

  it('records cleanup failure and continues dispatching eligible work', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', workId(202));
    const nowIso = '2026-07-05T12:00:00.000Z';
    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(202),
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
      event.workItemKey === workId(202) &&
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
      workItemKey: workId(41),
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
      workItemKey: workId(41),
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
      workItemKey: workId(50),
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

    const afterFirst = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 50 });
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
        // Deliberately offset from the tick clock above. In production the
        // work source stamps its own ingestedAt inside pollEvents(), which
        // runs *after* the tick captures tickStartedAt, so the origin upsert
        // is always LATER than the tick's `now`. Pinning both clocks to the
        // same instant hides every ordering bug this asymmetry causes.
        now: () => new Date('2026-07-05T12:00:01.000Z'),
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

    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 60 });
    expect(projection?.correlatedResources).toEqual([
      {
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#60',
        role: 'representation',
        relation: 'primary',
        provenance: 'wake-created',
        // max(origin upsert's ingestedAt, tick's nowIso) — the origin upsert
        // (polled at 12:00:01) is later than the tick's start (12:00:00), so
        // the registration takes the upsert's timestamp and can never sort
        // before the projection it folds into.
        registeredAt: '2026-07-05T12:00:01.000Z',
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

  it('round 3: the auto-registration survives rm -rf state/ + replay when the source polls after the tick started (ADR 0001 rebuild guarantee)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createResourceIndex({ paths: store.paths });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickRunner = createTickRunner({
      // The tick captures `nowIso` at 12:00:00, before it polls; the work
      // source stamps its upsert at poll time, 12:00:01. This is the real
      // production relationship (pollEvents runs after tickStartedAt is
      // captured), and it is what every other fixture hides by pinning both
      // clocks to the same instant.
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      resourceIndex,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 62,
            title: 'Replay the origin registration',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const before = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 62 });
    expect(before?.correlatedResources).toEqual([
      expect.objectContaining({
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#62',
        role: 'representation',
        relation: 'primary',
        provenance: 'wake-created',
      }),
    ]);
    // The work id is minted, so it is read off the projection, never spelled out.
    const workItemKey = before?.workItemKey ?? '';
    expect(isWorkId(workItemKey)).toBe(true);
    expect(await resourceIndex.resolve('fake-ticketing:issue:atolis-hq/wake#62')).toBe(workItemKey);

    // state/ (projection AND index) is a rebuildable cache over events/.
    await rm(join(root, 'state'), { recursive: true, force: true });
    await createProjectionUpdater({ stateStore: store, resourceIndex })
      .rebuildFromEvents(await store.listEventEnvelopes());

    // If the registration were stamped with the tick's own `nowIso` it would
    // sort before the 12:00:01 upsert that creates the projection, fold
    // against `current === null`, and be silently dropped — leaving these two
    // assertions empty/undefined while the registration event still on record
    // stops any later tick from re-registering it. Permanent, silent loss.
    const after = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 62 });
    expect(after?.correlatedResources).toEqual(before?.correlatedResources);
    // Replay reproduces the *same* work id, because identity lives in the
    // events, not in state/.
    expect(after?.workItemKey).toBe(workItemKey);
    expect(await resourceIndex.resolve('fake-ticketing:issue:atolis-hq/wake#62')).toBe(workItemKey);

    // And the mechanism that makes the above hold: the registration is stamped
    // max(origin upsert's ingestedAt, tick's nowIso), never the tick's nowIso
    // alone, so it can never sort ahead of the upsert it depends on.
    expect(before?.correlatedResources[0]?.registeredAt).toBe('2026-07-05T12:00:01.000Z');
  });

  it('a tick that both discovers and dispatches an item survives rm -rf state/ + replay under an advancing clock (ADR 0001 rebuild guarantee)', async () => {
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createResourceIndex({ paths: store.paths });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    // A *sequenced* clock, not a frozen one. Every other fixture in this file
    // pins the tick clock and the source clock to the same instant, which makes
    // every event in the tick tie on ingestedAt — and a tie is invisible here,
    // because the sort in rebuildFromEvents is stable and therefore silently
    // preserves append order, making replay accidentally correct. Only a clock
    // that advances across calls reproduces the production relationship: the
    // tick's own reads straddle pollEvents(), which stamps at 12:00:01.
    //   1st read  (tick start / decision clock) -> 12:00:00
    //   poll                                     -> 12:00:01 (source's clock)
    //   every later read (event stamping)        -> 12:00:02, 12:00:03, ...
    const clockBaseMs = Date.parse('2026-07-05T12:00:00.000Z');
    let clockReads = 0;
    const sequencedClock = {
      now: () => {
        const offsetMs = clockReads === 0 ? 0 : (clockReads + 1) * 1000;
        clockReads += 1;
        return new Date(clockBaseMs + offsetMs);
      },
    };

    const tickRunner = createTickRunner({
      clock: sequencedClock,
      config,
      stateStore: store,
      resourceIndex,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 63,
            title: 'Discover and dispatch in one tick',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const before = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 63 });
    expect(before?.wake.stageHistory.map((entry) => entry.reason)).toContain('run:refine:claimed');

    // state/ is a rebuildable cache over events/ — nothing more.
    await rm(join(root, 'state'), { recursive: true, force: true });
    await createProjectionUpdater({ stateStore: store, resourceIndex })
      .rebuildFromEvents(await store.listEventEnvelopes());
    const after = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 63 });

    // Every event this tick stamps must be dated when it actually happened, so
    // none of them can sort ahead of the poll-time upsert that creates the
    // projection they fold into. An event stamped from a frozen tick-start
    // snapshot folds against `current === null` on replay and is silently
    // discarded, costing the replayed projection its claimed stageHistory
    // entry and recentEventIds — a divergence from the live fold.
    expect(after?.wake.stageHistory).toEqual(before?.wake.stageHistory);
    expect(after?.wake.lastRunId).toBe(before?.wake.lastRunId);
    expect(after?.context).toEqual(before?.context);
    expect(after).toEqual(before);
  });

  it('does not re-claim a deliberately retracted origin resource on a later tick', async () => {
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
        // Offset from the tick clock — see the auto-registration test above.
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex,
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    // First tick mints the work item, which registers the origin ticket.
    await tickRunner.runTick();
    const registeredBefore = (await store.listEventEnvelopes()).filter(
      (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
    );
    expect(registeredBefore).toHaveLength(1);

    const workItemKey =
      (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 61 }))
        ?.workItemKey ?? '';

    // The operator (or a later `wake correlate` command) deliberately
    // retracts the only correlated resource, leaving correlatedResources[]
    // legitimately empty — this must be durable, not just a transient state
    // that the next tick silently reverses.
    const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex });
    const retraction = createEventEnvelope({
      eventId: 'wake-61-origin-retracted',
      workItemKey,
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

    const afterRetraction = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 61 });
    expect(afterRetraction?.correlatedResources).toEqual([]);

    // A later tick must not silently re-claim the retracted uri for this work
    // item. There is no longer a back-fill pass that could: minting *is*
    // registration, and this work item is never minted again. The re-polled
    // upsert resolves by its already-persisted event id, so it folds back into
    // the same work item without re-registering anything.
    await tickRunner.runTick();

    const registeredAfter = (await store.listEventEnvelopes()).filter(
      (event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT,
    );
    expect(registeredAfter).toHaveLength(1);

    const finalProjection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 61 });
    expect(finalProjection?.correlatedResources).toEqual([]);
    expect(finalProjection?.workItemKey).toBe(workItemKey);

    // And no second work item was forked for the now-unclaimed ticket.
    expect(await store.listIssueStates()).toHaveLength(1);
  });

  it('mints a work id for a ticket discovered on a clean home, emitting created then registered, and keys state/ on it', async () => {
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
            number: 200,
            title: 'Mint me',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        // Offset from the tick clock, as production always is: the source
        // stamps ingestedAt inside pollEvents(), after the tick's own start.
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const projection = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 200,
    });
    expect(projection).not.toBeNull();
    const workId = projection?.workItemKey ?? '';
    expect(isWorkId(workId)).toBe(true);

    // The projection lands at state/<workId>.json — no provider, repo, or
    // issue segment anywhere in the path.
    await access(join(root, 'state', `${workId}.json`));

    // The index is what makes the *next* event resolve rather than re-mint.
    expect(await resourceIndex.resolve('fake-ticketing:issue:atolis-hq/wake#200')).toBe(workId);

    const events = await store.listEventEnvelopes();
    const mintEventTypes = events
      .filter(
        (event) =>
          event.workItemKey === workId &&
          (event.sourceEventType === WORK_ITEM_CREATED_EVENT ||
            event.sourceEventType === CORRELATION_REGISTERED_EVENT),
      )
      .map((event) => event.sourceEventType);
    expect(mintEventTypes).toEqual([WORK_ITEM_CREATED_EVENT, CORRELATION_REGISTERED_EVENT]);

    expect(projection?.correlatedResources).toEqual([
      {
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#200',
        role: 'representation',
        relation: 'primary',
        provenance: 'wake-created',
        registeredAt: '2026-07-05T12:00:01.000Z',
      },
    ]);
  });

  it('resolves a second event on the same ticket through the index to the same work id and mints nothing', async () => {
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createResourceIndex({ paths: store.paths });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    // The second tick's ticket carries a comment, so the second poll emits a
    // genuinely *new* event id for the same ticket. That is what forces the
    // resolver down the index path — re-polling the identical event id would
    // instead take the already-persisted shortcut and prove nothing about
    // resolution.
    const tickets = [
      {
        repo: 'atolis-hq/wake',
        number: 201,
        title: 'Mint once',
        body: 'Body',
        labels: ['wake:queue'],
        comments: [] as Array<{ id: string; body: string; author: { login: string } }>,
      },
    ];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      resourceIndex,
      workSource: createFakeTicketingSystem({
        tickets,
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();
    const firstWorkId = (
      await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 201 })
    )?.workItemKey;
    expect(isWorkId(firstWorkId ?? '')).toBe(true);

    tickets[0]!.comments.push({ id: 'c-201', body: 'A new comment', author: { login: 'alice' } });
    await tickRunner.runTick();

    const projections = await store.listIssueStates();
    expect(projections).toHaveLength(1);
    expect(projections[0]?.workItemKey).toBe(firstWorkId);

    const events = await store.listEventEnvelopes();
    const commentEvent = events.find(
      (event) => event.sourceEventType === 'fake.issue.comment.created',
    );
    expect(commentEvent?.workItemKey).toBe(firstWorkId);

    expect(
      events.filter((event) => event.sourceEventType === WORK_ITEM_CREATED_EVENT),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.sourceEventType === CORRELATION_REGISTERED_EVENT),
    ).toHaveLength(1);
  });

  it('mints two different work ids for two different tickets', async () => {
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
            number: 202,
            title: 'First',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
          {
            repo: 'atolis-hq/wake',
            number: 203,
            title: 'Second',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    const first = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 202,
    });
    const second = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 203,
    });

    expect(isWorkId(first?.workItemKey ?? '')).toBe(true);
    expect(isWorkId(second?.workItemKey ?? '')).toBe(true);
    expect(first?.workItemKey).not.toBe(second?.workItemKey);
  });

  it('re-registers the origin resource when an earlier mint was interrupted before it landed, so a later event does not fork a duplicate', async () => {
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createFakeResourceIndex();
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const tickets = [
      {
        repo: 'atolis-hq/wake',
        number: 301,
        title: 'Interrupted mint',
        body: 'Body',
        labels: ['wake:queue'],
        comments: [] as Array<{ id: string; body: string; author: { login: string } }>,
      },
    ];

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      resourceIndex,
      workSource: createFakeTicketingSystem({
        tickets,
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    // First tick mints the work item and registers its origin ticket.
    await tickRunner.runTick();
    const workItemKey =
      (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 301 }))?.workItemKey ?? '';
    expect(isWorkId(workItemKey)).toBe(true);
    const uri = 'fake-ticketing:issue:atolis-hq/wake#301';
    expect(await resourceIndex.resolve(uri)).toBe(workItemKey);

    // Simulate a crash that landed between appending the origin ticket's source
    // event and folding its origin correlation: the source event stays durable
    // (so the resolver's persisted shortcut fires and it is never re-minted),
    // but the index entry and the origin-correlation event never made it.
    await resourceIndex.retract(uri);
    await rm(join(root, 'events-by-id', `${workItemKey}-origin-correlation.json`), { force: true });
    await rm(join(root, 'events-by-id', `${workItemKey}-created.json`), { force: true });

    // A later poll re-emits the same upsert (heal path) and a brand-new comment
    // on the same ticket. Without healing, the comment would miss the index and
    // fork a second work item.
    tickets[0]!.comments.push({ id: 'c-301', body: 'ping', author: { login: 'alice' } });
    await tickRunner.runTick();

    expect(await resourceIndex.resolve(uri)).toBe(workItemKey);
    expect(await store.listIssueStates()).toHaveLength(1);
    const commentEvent = (await store.listEventEnvelopes()).find(
      (event) => event.sourceEventType === 'fake.issue.comment.created',
    );
    expect(commentEvent?.workItemKey).toBe(workItemKey);
  });

  it('does not re-claim a deliberately retracted origin resource via the heal path', async () => {
    // Sibling of the retraction test above, guarding the heal specifically: a
    // retracted resource resolves to undefined but keeps its origin-correlation
    // event, so the heal must leave it alone rather than re-register it.
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createFakeResourceIndex();
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
            number: 302,
            title: 'Retracted then re-polled',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();
    const uri = 'fake-ticketing:issue:atolis-hq/wake#302';
    // Retract only the index entry, leaving the origin-correlation event on
    // record — the durable signature of an intentional retraction, not a crash.
    await resourceIndex.retract(uri);

    await tickRunner.runTick();

    // The heal must NOT fire: the resource stays unclaimed.
    expect(await resourceIndex.resolve(uri)).toBeUndefined();
    expect(await store.listIssueStates()).toHaveLength(1);
  });

  it('does not re-append an already-persisted inbound event on a later tick', async () => {
    const store = createStateStore({ wakeRoot: root });
    const resourceIndex = createResourceIndex({ paths: store.paths });
    const config = createDefaultWakeConfig(root);
    config.sources.github.policy.requiredLabels = ['wake:queue'];

    const appendedIds: string[] = [];
    const countingStore = {
      ...store,
      async appendEventEnvelope(event: Parameters<typeof store.appendEventEnvelope>[0]) {
        appendedIds.push(event.eventId);
        return store.appendEventEnvelope(event);
      },
    };

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: countingStore,
      resourceIndex,
      workSource: createFakeTicketingSystem({
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 210,
            title: 'Once',
            body: 'Body',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
        now: () => new Date('2026-07-05T12:00:01.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();
    await tickRunner.runTick();

    // The upsert is durable after tick 1; tick 2 re-polls the identical event
    // id and must resolve it straight from disk without a second append.
    const upsertId = 'fake-issue-atolis-hq/wake-210';
    expect(appendedIds.filter((id) => id === upsertId)).toHaveLength(1);
  });

  it('keys the pending-marking runId on the work id, not the bare ticket number', async () => {
    const store = createStateStore({ wakeRoot: root });
    const pendingRunIds: string[] = [];

    for (const issueNumber of [41, 42]) {
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(issueNumber),
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
            streamScope: 'work-item' as const,
            direction: 'inbound' as const,
            sourceSystem: 'github',
            sourceEventType: 'ticket.comment.created',
            sourceRefs: {
              repo: 'atolis-hq/wake',
              issueNumber,
              commentId: `c-${issueNumber}`,
              resourceUri: githubIssueUri(issueNumber),
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
          if (
            input.event.sourceEventType === 'wake.labels.requested' &&
            input.event.payload.statusLabel === 'wake:status.pending'
          ) {
            pendingRunIds.push(String(input.event.sourceRefs.runId));
          }
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'Revised.\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: await seededResourceIndex([41, 42]),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    expect(pendingRunIds.length).toBeGreaterThanOrEqual(1);
    for (const runId of pendingRunIds) {
      expect(runId.startsWith('pending-work-')).toBe(true);
    }
    // The seeded work id appears; the bare "pending-41-"/"pending-42-" shape never does.
    expect(pendingRunIds.some((id) => id.includes(workId(41)) || id.includes(workId(42)))).toBe(true);
    expect(pendingRunIds.every((id) => !/^pending-4[12]-/.test(id))).toBe(true);
  });

  it('fails loudly rather than minting when a polled event carries no sourceRefs.resourceUri', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);

    // Deliberately ad-hoc rather than one of the fakes: both fakes stamp a
    // resourceUri by construction, so no fake can produce this shape. An
    // unkeyed event without a resourceUri is a programming error in the
    // adapter — the resolver has nothing to resolve and must never guess an
    // identity, because a guess forks a duplicate work item silently.
    const brokenWorkSource = {
      async pollEvents() {
        return [
          {
            schemaVersion: 1 as const,
            eventId: 'broken-1',
            streamScope: 'global-intake' as const,
            direction: 'inbound' as const,
            sourceSystem: 'broken-source',
            sourceEventType: 'ticket.upsert',
            sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 204 },
            occurredAt: '2026-07-05T12:00:01.000Z',
            ingestedAt: '2026-07-05T12:00:01.000Z',
            trigger: 'immediate' as const,
            payload: {},
          },
        ];
      },
    };

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      workSource: brokenWorkSource,
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await expect(tickRunner.runTick()).rejects.toThrow(/resourceUri/);

    const events = await store.listEventEnvelopes();
    expect(events.filter((event) => event.sourceEventType === WORK_ITEM_CREATED_EVENT)).toEqual([]);
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
        // Pinned to the tick clock deliberately, and this test must stay that
        // way while its `clock` is frozen. This tick clock returns 12:00:00 on
        // every read, so `eventStampNow()` cannot advance past the poll the way
        // a real clock does; polling at 12:00:01 would sort every Wake-stamped
        // event before the upsert that creates the projection and drop them on
        // replay — a frozen-clock artifact, not a production defect.
        //
        // The cost is that this fixture cannot see ordering bugs: equal
        // timestamps tie, the stable sort keeps append order, and replay comes
        // out right for the wrong reason. That blind spot is why three separate
        // ordering bugs survived here. It is covered instead by the dedicated
        // rebuild test above, which drives a *sequenced* clock (tick 12:00:00,
        // poll 12:00:01, stamping 12:00:02+) and is the fixture to extend if
        // you are testing ordering. This one proves projection equivalence for
        // a rich projection; that one proves ordering.
        now: () => new Date('2026-07-05T12:00:00.000Z'),
      }),
      runner: {
        async run() {
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    // First tick mints the work item, registering the origin ticket as its
    // primary representation.
    await tickRunner.runTick();

    // Minted, so it is read back off the projection rather than spelled out.
    const mintedWorkItemKey =
      (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 70 }))
        ?.workItemKey ?? '';
    expect(isWorkId(mintedWorkItemKey)).toBe(true);

    // Simulate additional correlated resources being discovered (e.g. an
    // implementation PR) via the same fold + index machinery a later
    // `wake correlate` command will drive, sharing the exact stateStore +
    // resourceIndex instances the tick runner uses.
    const projectionUpdater = createProjectionUpdater({ stateStore: store, resourceIndex });
    const prRegistration = createEventEnvelope({
      eventId: 'wake-70-pr-registered',
      workItemKey: mintedWorkItemKey,
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
      workItemKey: workId(90),
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
      workItemKey: workId(90),
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

    // A third and fourth work item whose *creation* order and *registration*
    // order disagree — the fixture that catches grouped-by-workItemKey
    // rebuild ordering bugs, which the #70/#90 pair above does not (there,
    // creation order and registration order happen to agree). Work item
    // #100 is created first (12:10) but registers the shared uri *second*
    // (12:30); work item #101 is created second (12:15) but registers the
    // shared uri *first* (12:20). Live/incremental folding (in true
    // chronological order, one event at a time, exactly as below) must make
    // #101 the primary (it registered first) and #100 the secondary with a
    // primary-conflict event naming #101 as incumbent. A rebuild that groups
    // by workItemKey and folds group-by-group in Map insertion order would
    // instead process #100's group to completion first (its earliest event,
    // the 12:10 creation, appears first in the overall event array), making
    // #100 the primary — silently disagreeing with the live result.
    const thirdIssueUpsert = createEventEnvelope({
      eventId: 'fake-issue-atolis-hq-wake-100',
      workItemKey: workId(100),
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'fake-ticketing',
      sourceEventType: 'fake.issue.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 100,
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#100',
      },
      occurredAt: '2026-07-05T12:10:00.000Z',
      ingestedAt: '2026-07-05T12:10:00.000Z',
      trigger: 'immediate',
      payload: {
        issue: {
          repo: 'atolis-hq/wake',
          number: 100,
          title: 'Created first, registers second',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          state: 'open',
          url: 'https://example.test/atolis-hq/wake/issues/100',
          createdAt: '2026-07-05T12:10:00.000Z',
          updatedAt: '2026-07-05T12:10:00.000Z',
        },
      },
    });
    const fourthIssueUpsert = createEventEnvelope({
      eventId: 'fake-issue-atolis-hq-wake-101',
      workItemKey: workId(101),
      streamScope: 'global-intake',
      direction: 'inbound',
      sourceSystem: 'fake-ticketing',
      sourceEventType: 'fake.issue.upsert',
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 101,
        resourceUri: 'fake-ticketing:issue:atolis-hq/wake#101',
      },
      occurredAt: '2026-07-05T12:15:00.000Z',
      ingestedAt: '2026-07-05T12:15:00.000Z',
      trigger: 'immediate',
      payload: {
        issue: {
          repo: 'atolis-hq/wake',
          number: 101,
          title: 'Created second, registers first',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          state: 'open',
          url: 'https://example.test/atolis-hq/wake/issues/101',
          createdAt: '2026-07-05T12:15:00.000Z',
          updatedAt: '2026-07-05T12:15:00.000Z',
        },
      },
    });
    const fourthWorkItemRegistersFirst = createEventEnvelope({
      eventId: 'wake-101-shared-registered',
      workItemKey: workId(101),
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 101, resourceUri: 'github:pr:atolis-hq/wake#72' },
      occurredAt: '2026-07-05T12:20:00.000Z',
      ingestedAt: '2026-07-05T12:20:00.000Z',
      trigger: 'context-only',
      payload: {
        resourceUri: 'github:pr:atolis-hq/wake#72',
        role: 'implementation',
        relation: 'primary',
        provenance: 'agent-reported',
      },
    });
    const thirdWorkItemRegistersSecond = createEventEnvelope({
      eventId: 'wake-100-shared-registered',
      workItemKey: workId(100),
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: CORRELATION_REGISTERED_EVENT,
      sourceRefs: { repo: 'atolis-hq/wake', issueNumber: 100, resourceUri: 'github:pr:atolis-hq/wake#72' },
      occurredAt: '2026-07-05T12:30:00.000Z',
      ingestedAt: '2026-07-05T12:30:00.000Z',
      trigger: 'context-only',
      payload: {
        resourceUri: 'github:pr:atolis-hq/wake#72',
        role: 'implementation',
        relation: 'primary',
        provenance: 'agent-reported',
      },
    });

    // Fold strictly in chronological (ingestedAt) order, one event at a
    // time, exactly like the live/incremental tick path does — this is the
    // "before" ground truth the rebuild must reproduce.
    for (const event of [
      thirdIssueUpsert,
      fourthIssueUpsert,
      fourthWorkItemRegistersFirst,
      thirdWorkItemRegistersSecond,
    ]) {
      await store.appendEventEnvelope(event);
      await projectionUpdater.rebuildFromEvents([event]);
    }

    const beforeCreatedFirst = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 100 });
    const beforeCreatedSecond = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 101 });
    expect(beforeCreatedSecond?.correlatedResources).toEqual([
      {
        resourceUri: 'github:pr:atolis-hq/wake#72',
        role: 'implementation',
        relation: 'primary',
        provenance: 'agent-reported',
        registeredAt: '2026-07-05T12:20:00.000Z',
      },
    ]);
    expect(beforeCreatedFirst?.correlatedResources).toEqual([
      {
        resourceUri: 'github:pr:atolis-hq/wake#72',
        role: 'implementation',
        relation: 'secondary',
        provenance: 'agent-reported',
        registeredAt: '2026-07-05T12:30:00.000Z',
      },
    ]);
    expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#72')).toBe(
      workId(101),
    );

    const disagreeingOrderConflictEventBefore = (await store.listEventEnvelopes()).find(
      (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT
        && (event.payload as { resourceUri?: string }).resourceUri === 'github:pr:atolis-hq/wake#72',
    );
    expect(disagreeingOrderConflictEventBefore?.eventId).toBe(
      'wake-100-shared-registered-primary-conflict',
    );

    const beforeIncumbent = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 70 });
    expect(beforeIncumbent?.correlatedResources.length ?? 0).toBeGreaterThanOrEqual(2);

    const beforeClaimant = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 90 });
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
      mintedWorkItemKey,
    );

    const beforeAllEvents = await store.listEventEnvelopes();
    const conflictEventCountBefore = beforeAllEvents.filter(
      (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT,
    ).length;
    expect(conflictEventCountBefore).toBe(2);

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

    const afterIncumbent = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 70 });
    expect(afterIncumbent).toEqual(beforeIncumbent);

    const afterClaimant = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 90 });
    expect(afterClaimant).toEqual(beforeClaimant);

    // The disagreeing-order pair: replay must reproduce the *live* winner
    // (#101, who registered first chronologically), not whichever work item
    // a workItemKey-grouped rebuild happened to visit first.
    const afterCreatedFirst = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 100 });
    expect(afterCreatedFirst).toEqual(beforeCreatedFirst);

    const afterCreatedSecond = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 101 });
    expect(afterCreatedSecond).toEqual(beforeCreatedSecond);

    expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#72')).toBe(
      workId(101),
    );

    const disagreeingOrderConflictEventAfter = (await store.listEventEnvelopes()).find(
      (event) => event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT
        && (event.payload as { resourceUri?: string }).resourceUri === 'github:pr:atolis-hq/wake#72',
    );
    expect(disagreeingOrderConflictEventAfter?.eventId).toBe(
      disagreeingOrderConflictEventBefore?.eventId,
    );

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
