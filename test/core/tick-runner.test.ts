import { beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeArtifactVerifier } from '../../src/adapters/fake/fake-artifact-verifier.js';
import { createFakeGitHubPullRequestActivitySource } from '../../src/adapters/fake/fake-github-pull-request-activity-source.js';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createResourceIndex } from '../../src/adapters/fs/resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createOutboundSinkRouter, createWorkSourceFanIn } from '../../src/core/sink-router.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import {
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  CORRELATION_REGISTERED_EVENT,
  WORK_ITEM_CREATED_EVENT,
} from '../../src/domain/schema.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';
import { createEventEnvelope, createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';
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

/**
 * A single ticket.upsert-shaped inbound event, carrying payload.ticket — the
 * shape the real github-issues-work-source stamps (and the shape
 * policy.qualifiesForMint reads for 'issue'-kind resources). The fake
 * ticketing harness (createFakeTicketingSystem) stamps payload.issue under
 * sourceEventType 'fake.issue.upsert' instead, so it cannot exercise the
 * qualification gate directly — this builds the real shape.
 */
function ticketUpsertWorkSource(input: {
  repo: string;
  issueNumber: number;
  labels: string[];
  now: Date;
}) {
  const nowIso = input.now.toISOString();
  const sourceUrl = `https://example.test/${input.repo}/issues/${input.issueNumber}`;

  return {
    async pollEvents() {
      return [
        createUnkeyedEventEnvelope({
          eventId: `ticket-upsert-${input.repo}-${input.issueNumber}`,
          streamScope: 'global-intake',
          direction: 'inbound',
          sourceSystem: 'github',
          sourceEventType: 'ticket.upsert',
          sourceRefs: {
            repo: input.repo,
            issueNumber: input.issueNumber,
            sourceUrl,
            resourceUri: githubIssueUri(input.issueNumber),
          },
          occurredAt: nowIso,
          ingestedAt: nowIso,
          trigger: 'immediate',
          payload: {
            ticket: {
              repo: input.repo,
              number: input.issueNumber,
              title: 'Ticket',
              body: 'Body',
              labels: input.labels,
              assignees: [],
              isPullRequest: false,
              state: 'open',
              url: sourceUrl,
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          },
        }),
      ];
    },
  };
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
        const runFiles = (await readdir(join(root, 'runs'))).filter((file) =>
          file.endsWith('.json'),
        );
        runFileSnapshot = await readFile(join(root, 'runs', runFiles[0]!), 'utf8');
        return {
          result: 'Runner output\nDONE',
          model: 'test-model',
          cli: 'test-cli',
          session_id: 'session-1',
        };
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
          return {
            result: 'Fake runner completed\nDONE',
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'fake-session-1',
          };
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
    expect(events).toContain(
      '"routing":{"runnerName":"fake-light","runnerKind":"fake","tier":"light"',
    );
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
              derivedHints: {},
            },
          ];
        },
      },
      runner: {
        async run() {
          callCount += 1;
          return {
            result: 'Need more detail\nBLOCKED',
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'session-2',
          };
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
    expect(runRecords[0]?.summary).toBe(
      'Implemented. The previous CI run FAILED, but this one passed.',
    );
    expect(runRecords[0]?.metadata).toMatchObject({
      envelope: 'structured',
    });
  });

  it('derives the watchlist from correlatedResources and passes it to pollEvents', async () => {
    const store = createStateStore({ wakeRoot: root });
    const pollEvents = vi.fn().mockResolvedValue([]);

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(91),
      issue: {
        repo: 'atolis-hq/wake',
        number: 91,
        title: 'Implement',
        body: 'Body',
        labels: ['wake:implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/91',
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
      correlatedResources: [
        {
          resourceUri: 'github:pr:org/repo#91',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:00:00.000Z',
        },
      ],
    });

    const config = createDefaultWakeConfig(root);

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: { pollEvents },
      outboundSink: {
        async deliverIntent() {
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

    await tickRunner.runTick();

    expect(pollEvents).toHaveBeenCalledWith({
      watch: expect.arrayContaining([{ resourceUri: 'github:pr:org/repo#91' }]),
    });
  });

  it('passes every correlated resourceUri through to pollEvents verbatim, deduplicated, without interpreting them', async () => {
    const store = createStateStore({ wakeRoot: root });
    const pollEvents = vi.fn().mockResolvedValue([]);

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(91),
      issue: {
        repo: 'atolis-hq/wake',
        number: 91,
        title: 'Implement',
        body: 'Body',
        labels: ['wake:implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/91',
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
      correlatedResources: [
        {
          resourceUri: 'github:issue:org/repo#91',
          role: 'representation',
          relation: 'primary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:00:00.000Z',
        },
        {
          resourceUri: 'github:pr:org/repo#91',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:00:00.000Z',
        },
        {
          resourceUri: 'github:pr-review-thread:org/repo#91/rt_501',
          role: 'implementation',
          relation: 'secondary',
          provenance: 'agent-reported',
          registeredAt: '2026-07-05T12:00:00.000Z',
        },
      ],
    });

    const config = createDefaultWakeConfig(root);

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
      config,
      stateStore: store,
      workSource: { pollEvents },
      outboundSink: {
        async deliverIntent() {
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

    await tickRunner.runTick();

    expect(pollEvents).toHaveBeenCalledWith({
      watch: [
        { resourceUri: 'github:issue:org/repo#91' },
        { resourceUri: 'github:pr:org/repo#91' },
        { resourceUri: 'github:pr-review-thread:org/repo#91/rt_501' },
      ],
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
          return {
            result:
              'Issue is well-specified. Please reply with /approved to proceed.\nAWAITING_APPROVAL',
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
      workSource: {
        async pollEvents() {
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
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

  it('invokes the ask custom command when awaiting approval and comment is /ask', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;
    let capturedWorkspaceMode: string | undefined;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(33),
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
          body: '/ask What changed in the implementation?',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-question',
        body: '/ask What changed in the implementation?',
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run(input) {
          runnerCallCount += 1;
          expect(input.action).toBe('ask');
          capturedWorkspaceMode = input.workspaceMode;
          return {
            result: 'The implementation updates the parser only.\nDONE',
            model: 'test-model',
            cli: 'test-cli',
          };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(runnerCallCount).toBe(1);
    expect(capturedWorkspaceMode).toBe('read-only');
  });

  it('runs a custom command without advancing or clearing awaiting approval', async () => {
    const store = createStateStore({ wakeRoot: root });
    let capturedAction: string | undefined;
    let capturedWorkspaceMode: string | undefined;
    let branchWorkspaceCalls = 0;
    let readOnlyWorkspaceCalls = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(35),
      issue: {
        repo: 'atolis-hq/wake',
        number: 35,
        title: 'Code Review Command Test',
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
          id: 'c-codereview',
          body: '/inspect check just the data layer',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-codereview',
        body: '/inspect check just the data layer',
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
    config.commands.inspect = {
      action: 'codereview',
      workspace: 'read-only',
      tier: 'standard',
    };

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
          capturedAction = input.action;
          capturedWorkspaceMode = input.workspaceMode;
          return { result: 'No findings.\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: {
        async prepareWorkspace() {
          branchWorkspaceCalls += 1;
          return { workspacePath: join(root, 'branch'), mergeConflictDetected: false };
        },
        async prepareReadOnlyClone() {
          readOnlyWorkspaceCalls += 1;
          return { workspacePath: join(root, 'readonly') };
        },
        async cleanupWorkspace() {},
      },
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(capturedAction).toBe('codereview');
    expect(capturedWorkspaceMode).toBe('read-only');
    expect(branchWorkspaceCalls).toBe(0);
    expect(readOnlyWorkspaceCalls).toBe(1);
    if (result.status === 'processed') {
      expect(result.nextStage).toBeNull();
    }

    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 35 });
    expect(projection?.wake.stage).toBe('implement');
    expect(projection?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
    expect(projection?.context.pendingApprovalAction).toBe('implement');
    expect(projection?.context.lastHandledCommentId).toBe('c-codereview');
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
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

  it('invokes the revise action (not idle) when awaiting approval and the latest unhandled comment is PR-sourced (no slash command required)', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;
    let capturedAction: string | undefined;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(99),
      issue: {
        repo: 'atolis-hq/wake',
        number: 99,
        title: 'Review Feedback Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/99',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'pr-review-comment-501',
          body: 'Rename "item" to "work item"',
          author: { login: 'reviewer' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_501',
          reviewThread: { path: 'docs/example.md', line: 3 },
        },
      ],
      latestComment: {
        id: 'pr-review-comment-501',
        body: 'Rename "item" to "work item"',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_501',
        reviewThread: { path: 'docs/example.md', line: 3 },
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run(input) {
          runnerCallCount += 1;
          capturedAction = input.action;
          return {
            result: 'Renamed it and pushed.\nAWAITING_APPROVAL',
            model: 'test-model',
            cli: 'test-cli',
          };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(runnerCallCount).toBe(1);
    expect(capturedAction).toBe('revise');

    const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 99 });
    expect(projection?.wake.stage).toBe('implement');
    expect(projection?.context.lastRunSentinel).toBe('AWAITING_APPROVAL');
  });

  it("does not route the revise run's status card to the triggering review thread (agent replies to threads itself)", async () => {
    const store = createStateStore({ wakeRoot: root });
    const publishIntents: EventEnvelope[] = [];

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(97),
      issue: {
        repo: 'atolis-hq/wake',
        number: 97,
        title: 'Review Feedback Routing Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/97',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'pr-review-comment-701',
          body: 'Rename "item" to "work item"',
          author: { login: 'reviewer' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_701',
          reviewThread: { path: 'docs/example.md', line: 3 },
        },
      ],
      latestComment: {
        id: 'pr-review-comment-701',
        body: 'Rename "item" to "work item"',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_701',
        reviewThread: { path: 'docs/example.md', line: 3 },
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      outboundSink: {
        async deliverIntent(input) {
          if (input.event.sourceEventType === 'wake.publish.intent.requested') {
            publishIntents.push(input.event);
          }
          return [];
        },
      },
      runner: {
        async run() {
          return {
            result: 'Renamed it and pushed.\nAWAITING_APPROVAL',
            model: 'test-model',
            cli: 'test-cli',
          };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(publishIntents).toHaveLength(1);
    expect(publishIntents[0]?.sourceRefs.resourceUri).toBeUndefined();
  });

  it('retries the failed action itself (not the stage default) after a FAILED sentinel with a fresh human reply', async () => {
    // Reproduces two production incidents in one tick: a `revise` run FAILED
    // (crash / stale-run reconciliation) while a fresh PR review comment was
    // still unhandled. lastRunSentinel !== AWAITING_APPROVAL after FAILED, so
    // dispatch falls into the non-awaiting-approval branch — which used to
    // pick the *stage's* default action (`implement`) instead of retrying the
    // action that actually failed (`revise`), silently discarding the
    // in-flight PR-feedback work and running a full fresh implement instead.
    const store = createStateStore({ wakeRoot: root });
    let capturedAction: string | undefined;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(96),
      issue: {
        repo: 'atolis-hq/wake',
        number: 96,
        title: 'Retry Same Action Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/96',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'pr-review-comment-801',
          body: 'Please also update the docs link.',
          author: { login: 'reviewer' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_801',
          reviewThread: { path: 'docs/example.md', line: 3 },
        },
      ],
      latestComment: {
        id: 'pr-review-comment-801',
        body: 'Please also update the docs link.',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr-review-thread:atolis-hq/wake#100/rt_801',
        reviewThread: { path: 'docs/example.md', line: 3 },
      },
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        syncedAt: '2026-07-05T12:00:00.000Z',
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: {
        lastRunSentinel: 'FAILED',
        lastFailureClass: 'infra',
        lastRunAction: 'revise',
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
          return [];
        },
      },
      runner: {
        async run(input) {
          capturedAction = input.action;
          return {
            result: 'Updated the docs link.\nAWAITING_APPROVAL',
            model: 'test-model',
            cli: 'test-cli',
          };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();

    expect(result.status).toBe('processed');
    expect(capturedAction).toBe('revise');
  });

  it('stays idle when awaiting approval and the latest PR-sourced comment was already handled', async () => {
    const store = createStateStore({ wakeRoot: root });
    let runnerCallCount = 0;

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(98),
      issue: {
        repo: 'atolis-hq/wake',
        number: 98,
        title: 'Review Feedback Idle Test',
        body: 'Body',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/98',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
      },
      comments: [
        {
          id: 'pr-review-comment-402',
          body: 'Already addressed this.',
          author: { login: 'reviewer' },
          createdAt: '2026-07-05T12:05:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
          isBotAuthored: false,
          resourceUri: 'github:pr:atolis-hq/wake#100',
        },
      ],
      latestComment: {
        id: 'pr-review-comment-402',
        body: 'Already addressed this.',
        author: { login: 'reviewer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
        resourceUri: 'github:pr:atolis-hq/wake#100',
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
        lastHandledCommentId: 'pr-review-comment-402',
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

    expect(result.status).toBe('idle');
    expect(runnerCallCount).toBe(0);
  });

  it('marks synced approval replies pending before the next item is claimed', async () => {
    const store = createStateStore({ wakeRoot: root });
    const deliveredEvents: Array<{
      issueNumber: number | undefined;
      statusLabel: string;
      stageLabel: string;
    }> = [];
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
          return [
            {
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
            },
          ];
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
      workSource: {
        async pollEvents() {
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
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: {
        async prepareWorkspace() {
          throw new Error('git network failure');
        },
        async prepareReadOnlyClone() {
          throw new Error('git network failure');
        },
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
    const completedEvent = events
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l))
      .find(
        (e: { payload?: { reason?: string } }) =>
          e.payload?.reason === 'runner:infrastructure-error',
      );
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
          return {
            result: 'Nope\nFAILED',
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'session-4',
          };
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
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 112,
            title: 'Quota pause',
            body: '',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
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
            result:
              "Claude runner failed: You've hit your session limit - resets 1:10am (UTC)\nFAILED",
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
        repo: 'atolis-hq/wake',
        number: 124,
        title: 'Recovered run',
        body: '',
        labels: ['wake'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/124',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:01:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'done',
        lastRunId: 'run-124-new',
        syncedAt: '2026-07-05T12:01:00.000Z',
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
      },
      context: { lastRunAction: 'implement', lastRunSentinel: 'DONE' },
      correlatedResources: [],
    });
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-124-stale',
      workItemKey: workId(124),
      repo: 'atolis-hq/wake',
      issueNumber: 124,
      action: 'implement',
      status: 'running',
      startedAt: '2026-07-05T12:00:00.000Z',
    });
    await store.writeRunRecord({
      schemaVersion: 1,
      runId: 'run-124-new',
      workItemKey: workId(124),
      repo: 'atolis-hq/wake',
      issueNumber: 124,
      action: 'implement',
      status: 'completed',
      startedAt: '2026-07-05T12:00:30.000Z',
      finishedAt: '2026-07-05T12:01:00.000Z',
      sentinel: 'DONE',
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
          throw new Error('should not run');
        },
      },
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
    const transcriptPath = join(
      root,
      'transcripts',
      workId(200),
      'run-200-1',
      'run-200-1.codex.implement.prompt.txt',
    );
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'DONE', model: 'test', cli: 'test' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    await expect(access(workspacePath)).rejects.toThrow();
    await expect(access(transcriptPath)).rejects.toThrow();
    const updatedProjection = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 200,
    });
    expect(updatedProjection?.wake.workspacePath).toBeUndefined();
  });

  it('retains transcripts for closed workspace cleanup when configured', async () => {
    const store = createStateStore({ wakeRoot: root });
    const workspacePath = join(root, 'workspaces', workId(204));
    const transcriptPath = join(
      root,
      'transcripts',
      workId(204),
      'run-204-1',
      'run-204-1.codex.implement.prompt.txt',
    );
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'DONE', model: 'test', cli: 'test' };
        },
      },
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
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run() {
          return { result: 'DONE', model: 'test', cli: 'test' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    await tickRunner.runTick();

    await expect(access(canonicalClonePath)).resolves.toBeUndefined();
    const updatedProjection = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 201,
    });
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
        repo: 'atolis-hq/wake',
        number: 202,
        title: 'Locked workspace',
        body: '',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'closed',
        url: 'https://example.test/issues/202',
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      comments: [],
      wake: {
        stage: 'done',
        workspacePath,
        syncedAt: nowIso,
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
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
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 203,
            title: 'Runnable',
            body: '',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      runner: {
        async run() {
          return { result: 'Refined\nDONE', model: 'test', cli: 'test' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: {
        ...fakeWorkspace,
        async cleanupWorkspace() {
          throw new Error('EPERM: workspace is locked');
        },
      },
    });

    const result = await tickRunner.runTick();
    const events = await store.listEventEnvelopes();

    expect(result.status).toBe('processed');
    expect(
      events.some(
        (event) =>
          event.sourceEventType === 'wake.workspace.cleanup-failed' &&
          event.workItemKey === workId(202) &&
          event.payload.error === 'EPERM: workspace is locked',
      ),
    ).toBe(true);
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
        tickets: [
          {
            repo: 'atolis-hq/wake',
            number: 40,
            title: 'Delivery failure',
            body: '',
            labels: ['wake:queue'],
            comments: [],
          },
        ],
      }),
      outboundSink: {
        async deliverIntent() {
          throw new Error('GitHub 503');
        },
      },
      runner: {
        async run() {
          return {
            result: 'Refined\nDONE',
            model: 'test-model',
            cli: 'test-cli',
            session_id: 'session-40',
          };
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
        repo: 'atolis-hq/wake',
        number: 41,
        title: 'Outbox retry',
        body: '',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/41',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [],
      wake: {
        stage: 'implement',
        syncedAt: '2026-07-05T12:00:00.000Z',
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
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
      payload: {
        kind: 'question',
        body: 'What should happen here?',
        action: 'refine',
        runId: 'run-41',
      },
    };
    await store.appendEventEnvelope(orphanedIntent);

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
        async deliverIntent() {
          deliverAttempts += 1;
          throw new Error('still down');
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
        repo: 'atolis-hq/wake',
        number: 50,
        title: 'Infra blip',
        body: '',
        labels: ['wake:queue'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://example.test/issues/50',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      comments: [
        {
          id: 'c-trigger',
          body: 'Please pick this up.',
          author: { login: 'owner' },
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
          isBotAuthored: false,
        },
      ],
      latestComment: {
        id: 'c-trigger',
        body: 'Please pick this up.',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
        isBotAuthored: false,
      },
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

    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
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
          return { result: 'Refined\nDONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: {
        async prepareWorkspace() {
          return { workspacePath: 'unused', mergeConflictDetected: false };
        },
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
    await createProjectionUpdater({ stateStore: store, resourceIndex }).rebuildFromEvents(
      await store.listEventEnvelopes(),
    );

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
    await createProjectionUpdater({ stateStore: store, resourceIndex }).rebuildFromEvents(
      await store.listEventEnvelopes(),
    );
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
      (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 61 }))?.workItemKey ?? '';

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

    const afterRetraction = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 61,
    });
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

    const finalProjection = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 61,
    });
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
    const firstWorkId = (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 201 }))
      ?.workItemKey;
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
      (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 301 }))?.workItemKey ??
      '';
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
    expect(pendingRunIds.some((id) => id.includes(workId(41)) || id.includes(workId(42)))).toBe(
      true,
    );
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

  it('parks a projection as workflow-changed when its stored stage is no longer configured', async () => {
    const store = createStateStore({ wakeRoot: root });
    const config = createDefaultWakeConfig(root);
    config.workflows = {
      default: {
        stages: {
          refine: {
            action: 'refine',
            workspace: 'read-only',
            tier: 'light',
            onDone: 'done',
          },
        },
      },
    };

    await store.writeIssueState({
      schemaVersion: 1,
      workItemKey: workId(92),
      issue: {
        repo: 'atolis-hq/wake',
        number: 92,
        title: 'Drifted',
        body: 'Body',
        labels: ['wake:stage.implement'],
        assignees: [],
        isPullRequest: false,
        state: 'open',
        url: 'https://github.com/atolis-hq/wake/issues/92',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z',
      },
      wake: {
        stage: 'implement',
        stageHistory: [],
        recentEventIds: [],
        expectedEcho: { commentIds: [], labels: [] },
        syncedAt: '2026-07-05T12:00:00.000Z',
      },
      context: {},
      correlatedResources: [],
      comments: [],
    });

    let runs = 0;
    const tickRunner = createTickRunner({
      clock: { now: () => new Date('2026-07-05T12:30:00.000Z') },
      config,
      stateStore: store,
      workSource: {
        async pollEvents() {
          return [];
        },
      },
      runner: {
        async run() {
          runs += 1;
          return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
        },
      },
      resourceIndex: createFakeResourceIndex(),
      workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
    });

    const result = await tickRunner.runTick();
    const projection = await store.readIssueState(workId(92));

    expect(result.status).toBe('processed');
    expect(runs).toBe(0);
    expect(projection?.wake.stage).toBe('implement');
    expect(projection?.wake.blockReason).toBe('workflow-changed');
    expect(projection?.context.lastRunSentinel).toBe('BLOCKED');
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
      (await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 70 }))?.workItemKey ?? '';
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
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 70,
        resourceUri: 'github:pr:atolis-hq/wake#71',
      },
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
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 90,
        resourceUri: 'github:pr:atolis-hq/wake#71',
      },
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
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 101,
        resourceUri: 'github:pr:atolis-hq/wake#72',
      },
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
      sourceRefs: {
        repo: 'atolis-hq/wake',
        issueNumber: 100,
        resourceUri: 'github:pr:atolis-hq/wake#72',
      },
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

    const beforeCreatedFirst = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 100,
    });
    const beforeCreatedSecond = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 101,
    });
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
    expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#72')).toBe(workId(101));

    const disagreeingOrderConflictEventBefore = (await store.listEventEnvelopes()).find(
      (event) =>
        event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT &&
        (event.payload as { resourceUri?: string }).resourceUri === 'github:pr:atolis-hq/wake#72',
    );
    expect(disagreeingOrderConflictEventBefore?.eventId).toBe(
      'wake-100-shared-registered-primary-conflict',
    );

    const beforeIncumbent = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 70,
    });
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
    expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#71')).toBe(mintedWorkItemKey);

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
    const afterCreatedFirst = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 100,
    });
    expect(afterCreatedFirst).toEqual(beforeCreatedFirst);

    const afterCreatedSecond = await findByIssueRef(store, {
      repo: 'atolis-hq/wake',
      issueNumber: 101,
    });
    expect(afterCreatedSecond).toEqual(beforeCreatedSecond);

    expect(await resourceIndex.resolve('github:pr:atolis-hq/wake#72')).toBe(workId(101));

    const disagreeingOrderConflictEventAfter = (await store.listEventEnvelopes()).find(
      (event) =>
        event.sourceEventType === CORRELATION_PRIMARY_CONFLICT_EVENT &&
        (event.payload as { resourceUri?: string }).resourceUri === 'github:pr:atolis-hq/wake#72',
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

  describe('artifact reporting', () => {
    it('registers a verified PR artifact reported by the agent', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(41),
        issue: {
          repo: 'atolis-hq/wake',
          number: 41,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/41',
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

      const artifactVerifier = createFakeArtifactVerifier({
        verifies: [
          { url: 'https://example.test/org/repo/pull/91', resourceUri: 'github:pr:org/repo#91' },
        ],
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: [
                'Opened the PR.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'fake-session-1',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier,
      });

      await tickRunner.runTick();

      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 41 });
      expect(projection?.correlatedResources).toContainEqual(
        expect.objectContaining({
          resourceUri: 'github:pr:org/repo#91',
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        }),
      );
    });

    it('does not register an artifact that fails verification', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(42),
        issue: {
          repo: 'atolis-hq/wake',
          number: 42,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/42',
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

      // verifies: [] — verify() always returns null, exercising the failed-
      // verification path.
      const artifactVerifier = createFakeArtifactVerifier({ verifies: [] });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: [
                'Opened the PR.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'fake-session-1',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier,
      });

      await tickRunner.runTick();

      const projection = await findByIssueRef(store, { repo: 'atolis-hq/wake', issueNumber: 42 });
      expect(
        projection?.correlatedResources.some((r) => r.resourceUri === 'github:pr:org/repo#91'),
      ).toBe(false);
    });

    it("threads the work item's own repo into the artifact verifier context", async () => {
      // Fix 3 regression: the artifact verifier must be able to confirm a
      // reported PR's repo matches the work item's own repo, not just its
      // branch — a low-entropy branch name like wake/issue-<n> could
      // otherwise match a PR in an unrelated repo. This proves tick-runner
      // actually threads the work item's repo (candidate.issue.repo) through
      // to the verifier's context, using a verifier that records what it was
      // called with rather than the shared fake (which ignores context).
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(43),
        issue: {
          repo: 'atolis-hq/wake',
          number: 43,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
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
        context: {},
        correlatedResources: [],
      });

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      const capturedContexts: Array<{ branch: string; repo: string }> = [];
      const artifactVerifier = {
        async verify(_artifact: unknown, context: { branch: string; repo: string }) {
          capturedContexts.push(context);
          return null;
        },
      };

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            return {
              result: [
                'Opened the PR.',
                '',
                '```wake-artifacts',
                '{ "artifacts": [{ "kind": "pr", "url": "https://example.test/org/repo/pull/91" }] }',
                '```',
                '',
                '```wake-result',
                '{ "status": "AWAITING_APPROVAL" }',
                '```',
                'AWAITING_APPROVAL',
              ].join('\n'),
              model: 'fake',
              cli: 'Fake',
              session_id: 'fake-session-1',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        artifactVerifier,
      });

      await tickRunner.runTick();

      expect(capturedContexts).toHaveLength(1);
      expect(capturedContexts[0]?.repo).toBe('atolis-hq/wake');
    });
  });

  describe('mint qualification gate', () => {
    it('parks an unqualified unresolved event in global-intake instead of minting', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:assign'];

      const now = new Date('2026-07-05T12:00:00.000Z');

      const tickRunner = createTickRunner({
        clock: { now: () => now },
        config,
        stateStore: store,
        workSource: ticketUpsertWorkSource({
          repo: 'atolis-hq/wake',
          issueNumber: 501,
          labels: [],
          now,
        }),
        runner: {
          async run() {
            throw new Error('runner must not be invoked for an unqualified event');
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const outcome = await tickRunner.runTick();
      expect(outcome.status).toBe('idle');

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(0);

      // listEventEnvelopesForWorkItem reads recentEventIds off a projection,
      // which the 'unresolved' sentinel key never has — read the raw JSONL
      // event log directly instead, the same pattern used elsewhere in this
      // file (e.g. "creates event audit records for sync and completion").
      const lines = (await readFile(join(root, 'events', '2026-07-05.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              workItemKey: string;
              sourceRefs: { resourceUri?: string };
            },
        );
      const unresolvedEvents = lines.filter((event) => event.workItemKey === 'unresolved');

      expect(unresolvedEvents).toHaveLength(1);
      expect(unresolvedEvents[0]?.sourceRefs.resourceUri).toBe(githubIssueUri(501));
    });

    it('still mints a work item for a qualifying unresolved event', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      const now = new Date('2026-07-05T12:00:00.000Z');

      const tickRunner = createTickRunner({
        clock: { now: () => now },
        config,
        stateStore: store,
        workSource: ticketUpsertWorkSource({
          repo: 'atolis-hq/wake',
          issueNumber: 502,
          labels: ['wake:queue'],
          now,
        }),
        runner: {
          async run() {
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const outcome = await tickRunner.runTick();
      expect(outcome.status).not.toBe('idle');

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(1);
    });

    it('resolves a first-sighting PR review-thread comment to the owning PR work item via sourceRefs.parentResourceUri, rather than quarantining it as unresolved', async () => {
      // A review-thread comment's resourceUri is unique per thread and is
      // never registered in the index on its own — only the owning PR's
      // resourceUri is. Without the parentResourceUri fallback, resolving
      // straight off the thread's resourceUri always misses the index and
      // (since qualifiesForMint has no 'pr-review-thread' case) permanently
      // quarantines the event under UNRESOLVED_WORK_ITEM_KEY.
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      const prResourceUri = 'github:pr:org/repo#91';
      const threadResourceUri = 'github:pr-review-thread:org/repo#91/rt_501';
      const key = workId(91);

      const resourceIndex = createFakeResourceIndex();
      await resourceIndex.register(prResourceUri, key);

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: key,
        issue: {
          repo: 'atolis-hq/wake',
          number: 91,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/91',
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
        correlatedResources: [
          {
            resourceUri: prResourceUri,
            role: 'implementation',
            relation: 'primary',
            provenance: 'agent-reported',
            registeredAt: '2026-07-05T12:00:00.000Z',
          },
        ],
      });

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [
              createUnkeyedEventEnvelope({
                eventId: 'pr-review-comment-org-repo-91-601-2026-07-05T12:00:00.000Z',
                streamScope: 'work-item',
                direction: 'inbound',
                sourceSystem: 'github-pr',
                sourceEventType: 'pr.review-comment.created',
                sourceRefs: {
                  resourceUri: threadResourceUri,
                  parentResourceUri: prResourceUri,
                  commentId: '601',
                },
                occurredAt: '2026-07-05T12:00:00.000Z',
                ingestedAt: '2026-07-05T12:00:00.000Z',
                trigger: 'context-only',
                payload: {
                  comment: {
                    id: 'pr-review-comment-601',
                    body: 'Nit: rename this variable.',
                    author: { login: 'reviewer' },
                    createdAt: '2026-07-05T12:00:00.000Z',
                    updatedAt: '2026-07-05T12:00:00.000Z',
                    resourceUri: threadResourceUri,
                  },
                },
              }),
            ];
          },
        },
        runner: {
          async run() {
            throw new Error('should not run');
          },
        },
        resourceIndex,
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const projections = await store.listIssueStates();
      expect(projections).toHaveLength(1);
      expect(projections[0]?.workItemKey).toBe(key);
      expect(projections[0]?.latestComment?.id).toBe('pr-review-comment-601');
      expect(projections[0]?.correlatedResources.map((r) => r.resourceUri)).toContain(
        threadResourceUri,
      );
      expect(
        projections[0]?.correlatedResources.find((r) => r.resourceUri === threadResourceUri)
          ?.relation,
      ).toBe('secondary');
    });
  });

  describe('end-to-end: issue -> implement -> PR review comment -> resume -> reply on the thread', () => {
    it('resumes the issue work item from a PR review comment and replies on the PR sink, not the issue sink', async () => {
      // Adaptation 1 (brief step 6/7 named a review-thread comment routed to
      // `github:pr-review-thread:...`): the fake PR activity source (Task
      // 10, fake-github-pull-request-activity-source.ts) only emits plain
      // `pr.comment.created` conversation events, never
      // `pr.review-comment.created` review-thread events. Per this task's
      // brief guidance (option a), this scenario uses a plain PR
      // conversation comment (`github:pr:org/repo#91`) instead. It still
      // proves every load-bearing claim: an agent-reported PR is verified
      // and registered (step 3), a human reply resumes the SAME session
      // (steps 1-4), and a later comment on the PR surface resumes that
      // same session again and gets its reply routed to the PR sink instead
      // of the issue sink (steps 5-7) — extending a review thread instead of
      // the top-level conversation would exercise the same routing code
      // path (sinkNameForResourceUri treats 'pr' and 'pr-review-thread'
      // identically), so nothing about the routing claim is weakened.
      //
      // Adaptation 2 (brief step 4 imagines a literal '/approved' comment
      // leaving the item "in 'implement' with a live session"): tracing the
      // real approval path shows this can't hold. Approving an
      // implement-stage AWAITING_APPROVAL always resolves via
      // lifecycle-service's `nextStageFromSentinel('implement', 'DONE')`,
      // which unconditionally returns 'done' — see the existing test
      // "transitions an awaiting-approval status to done when /approved
      // comment is present" above. Moving stage forward always clears
      // `wake.sessionId` (projection-updater.ts's `shouldClearSession`), so
      // a full approval leaves nothing for a later PR comment to resume.
      // This scenario instead uses the BLOCKED / human-reply resume cycle
      // this file already exercises elsewhere (e.g. "runs once when a new
      // human comment arrives on an eligible issue"), which is
      // session-preserving by design — while still posting a comment
      // literally worded '/approved' so the human step stays recognisable.
      //
      // PRODUCTION FIX NOTE: writing this scenario surfaced a real gap —
      // src/core/tick-runner.ts's createPublishIntentEvent never carried a
      // `resourceUri` on the outbound wake.publish.intent.requested event,
      // so createOutboundSinkRouter's PR-vs-issue routing (Task 11,
      // sink-router.ts, commit 7512226) had no signal to route on and every
      // reply landed on the issue sink regardless of which surface
      // triggered the run. Fixed narrowly by threading
      // `projection.latestComment?.resourceUri` (already populated by the
      // ad1cf45 comment fold when the triggering comment came from a
      // correlated PR/review surface) into that event's sourceRefs. See the
      // task report for detail.
      const repo = 'atolis-hq/wake';
      const issueNumber = 91;
      const workKey = workId(issueNumber);
      const prUrl = 'https://example.test/org/repo/pull/91';
      const prResourceUri = 'github:pr:org/repo#91';

      const store = createStateStore({ wakeRoot: root });
      const resourceIndex = createFakeResourceIndex();
      await resourceIndex.register(githubIssueUri(issueNumber), workKey);
      const workspaceManager = createFakeWorkspaceManager(join(root, 'workspaces'));

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      const artifactVerifier = createFakeArtifactVerifier({
        verifies: [{ url: prUrl, resourceUri: prResourceUri }],
      });

      // One shared issue-thread sink across all three ticks — every tick
      // must confirm its own outbound intents (deliverOutboundEvent ->
      // attemptDelivery) as it goes, or a later tick's
      // retryUnconfirmedDeliveries replays them in a batch instead. This
      // mirrors the no-op-reply outboundSink shape used throughout this
      // file (e.g. "publishes working then completed status labels...")
      // rather than createFakeTicketingSystem's full echo, which replaces
      // issue.labels with exactly `[statusLabel, stageLabel]` on delivery —
      // that would wipe this fixture's 'wake:implement' qualifying label,
      // which isn't one of Wake's own status/stage labels.
      const githubIssueSink = {
        async deliverIntent(_input: { event: EventEnvelope }): Promise<EventEnvelope[]> {
          return [];
        },
      };

      let runnerCallCount = 0;
      const capturedSessionIds: Array<string | undefined> = [];

      // Step 1: seed a ticket already in 'implement' with no prior run,
      // mirroring this file's implement-stage fixtures (e.g. "artifact
      // reporting" above).
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workKey,
        issue: {
          repo,
          number: issueNumber,
          title: 'Implement PR review flow',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: `https://example.test/${repo}/issues/${issueNumber}`,
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

      // Step 2: first tick — the agent opens a PR (reported via the
      // wake-artifacts fence, Task 4's pattern) but comes back BLOCKED with
      // a clarifying question rather than AWAITING_APPROVAL/DONE, so the
      // session survives to be resumed later (see adaptation 2 above).
      const tickRunner1 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: githubIssueSink,
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Opened the PR. Quick question before I finish up: should the retry cap be configurable?',
                '',
                '```wake-artifacts',
                `{ "artifacts": [{ "kind": "pr", "url": "${prUrl}" }] }`,
                '```',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      const tick1Result = await tickRunner1.runTick();
      expect(tick1Result.status).toBe('processed');
      expect((tick1Result as { sentinel?: string }).sentinel).toBe('BLOCKED');
      expect(runnerCallCount).toBe(1);

      // Step 3: correlatedResources holds the verified, agent-reported PR.
      let projection = await findByIssueRef(store, { repo, issueNumber });
      expect(projection?.correlatedResources).toContainEqual(
        expect.objectContaining({
          resourceUri: prResourceUri,
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
        }),
      );
      expect(projection?.wake.stage).toBe('implement');
      expect(projection?.wake.sessionId).toBe('session-91');
      expect(projection?.context.lastRunSentinel).toBe('BLOCKED');

      // Step 4: a human replies with a plain ticket comment (the same
      // inbound shape the fake ticketing system's comment-seed path
      // produces) — this resumes the SAME session rather than a fresh one.
      const tickRunner2 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:05:00.000Z') },
        config,
        stateStore: store,
        outboundSink: githubIssueSink,
        workSource: {
          async pollEvents() {
            return [
              {
                schemaVersion: 1,
                eventId: 'evt-comment-91-approved',
                streamScope: 'work-item',
                direction: 'inbound',
                sourceSystem: 'github',
                sourceEventType: 'ticket.comment.created',
                sourceRefs: {
                  repo,
                  issueNumber,
                  commentId: 'c-91-approved',
                  resourceUri: githubIssueUri(issueNumber),
                },
                occurredAt: '2026-07-05T12:05:00.000Z',
                ingestedAt: '2026-07-05T12:05:00.000Z',
                trigger: 'context-only',
                payload: {
                  comment: {
                    id: 'c-91-approved',
                    body: '/approved',
                    author: { login: 'owner' },
                    createdAt: '2026-07-05T12:05:00.000Z',
                    updatedAt: '2026-07-05T12:05:00.000Z',
                  },
                },
              },
            ];
          },
        },
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Thanks — keeping the retry cap fixed for now. One more thing to confirm before this is fully done.',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      const tick2Result = await tickRunner2.runTick();
      expect(tick2Result.status).toBe('processed');
      expect(runnerCallCount).toBe(2);
      // Same session resumed, not a fresh one.
      expect(capturedSessionIds[1]).toBe('session-91');

      projection = await findByIssueRef(store, { repo, issueNumber });
      expect(projection?.wake.stage).toBe('implement');
      expect(projection?.wake.sessionId).toBe('session-91');

      // Step 5: a fake PR activity source (Task 10) seeded with one PR
      // conversation comment on the now-correlated PR, fanned in alongside
      // the issue source, with an outbound sink router registering the
      // issue sink under 'github' (the projection's origin fallback) and
      // the PR sink under 'github-pr' (the name sinkNameForResourceUri
      // derives from a `github:pr:...`/`github:pr-review-thread:...`
      // resourceUri, per Task 11).
      const prActivitySource = createFakeGitHubPullRequestActivitySource({
        prs: [
          {
            repo: 'org/repo',
            number: 91,
            author: 'contributor',
            headRef: 'wake/91',
            comments: [
              {
                id: 'prc-1',
                body: 'Please also handle the null case on line 42.',
                author: 'reviewer',
              },
            ],
          },
        ],
        now: () => new Date('2026-07-05T12:10:00.000Z'),
      });

      const githubSinkReceived: EventEnvelope[] = [];
      const prSinkReceived: EventEnvelope[] = [];
      const prSinkPublished: EventEnvelope[] = [];

      const outboundSink = createOutboundSinkRouter({
        config,
        sinks: [
          {
            sink: 'github',
            async deliverIntent(input) {
              githubSinkReceived.push(input.event);
              return githubIssueSink.deliverIntent(input);
            },
          },
          {
            sink: 'github-pr',
            async deliverIntent(input) {
              prSinkReceived.push(input.event);
              const delivered = await prActivitySource.deliverIntent(input);
              prSinkPublished.push(...delivered);
              return delivered;
            },
          },
        ],
      });

      const workSource = createWorkSourceFanIn([
        {
          source: 'fake-ticketing',
          async pollEvents() {
            return [];
          },
        },
        { source: 'fake-github-pr', pollEvents: prActivitySource.pollEvents },
      ]);

      const tickRunner3 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource,
        outboundSink,
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Handled the null check on line 42, thanks for the catch.',
                '',
                '```wake-result',
                '{ "status": "BLOCKED" }',
                '```',
                'BLOCKED',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      // Step 6: second tick against the PR-aware runtime. The watchlist
      // (derived from correlatedResources registered in step 3) now
      // includes github:pr:org/repo#91, so the fake PR source emits the
      // conversation comment instead of a bare pr.seen event, and the work
      // item resumes with the SAME session rather than minting a new run.
      const tick3Result = await tickRunner3.runTick();
      expect(tick3Result.status).toBe('processed');
      expect(runnerCallCount).toBe(3);
      expect(capturedSessionIds[2]).toBe('session-91');

      projection = await findByIssueRef(store, { repo, issueNumber });
      expect(projection?.comments.some((c) => c.id === 'prc-1')).toBe(true);
      // The triggering comment is tagged with the PR surface it came from
      // (ad1cf45's comment fold) — this is exactly the signal the
      // production fix above threads onto the reply's publish intent.
      expect(projection?.latestComment?.resourceUri).toBe(prResourceUri);

      // Step 7: the reply was routed to the PR sink, not the issue sink —
      // the resourceUri on the triggering run's publish intent carries the
      // PR surface, and only the 'github-pr' sink received it.
      expect(
        githubSinkReceived.some(
          (event) => event.sourceEventType === 'wake.publish.intent.requested',
        ),
      ).toBe(false);
      expect(prSinkReceived).toHaveLength(1);
      expect(prSinkReceived[0]?.sourceEventType).toBe('wake.publish.intent.requested');
      expect(prSinkReceived[0]?.sourceRefs.resourceUri).toBe(prResourceUri);

      expect(prSinkPublished).toHaveLength(1);
      expect(prSinkPublished[0]?.sourceEventType).toBe('pr.comment.reply.published');

      // Step 8 (review fix regression): `latestComment` is a sticky,
      // per-work-item field (projection-updater.ts's comment fold overwrites
      // it unconditionally and nothing ever resets it) — it still points at
      // prc-1/prResourceUri here even though tick 3 already handled that
      // comment (context.lastHandledCommentId === 'prc-1'). Simulate a run
      // that completes for a reason OTHER than a fresh comment — an
      // automatic quota-failure retry, one of needsWakeAction's non-comment
      // trigger paths — and confirm the reply does NOT get misrouted to the
      // PR sink just because the projection's stale latestComment still
      // carries a PR resourceUri from a comment that was already replied to.
      const preTick4Projection = await findByIssueRef(store, { repo, issueNumber });
      expect(preTick4Projection).not.toBeNull();
      await store.writeIssueState({
        ...(preTick4Projection as IssueStateRecord),
        context: {
          ...(preTick4Projection as IssueStateRecord).context,
          lastRunSentinel: 'FAILED',
          lastFailureClass: 'quota',
          lastRunAction: 'implement',
        },
      });

      const tickRunner4 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:15:00.000Z') },
        config,
        stateStore: store,
        workSource: createWorkSourceFanIn([
          {
            source: 'fake-ticketing',
            async pollEvents() {
              return [];
            },
          },
          {
            source: 'fake-github-pr',
            async pollEvents() {
              return [];
            },
          },
        ]),
        outboundSink,
        runner: {
          async run(input) {
            runnerCallCount += 1;
            capturedSessionIds.push(input.projection.wake.sessionId);
            return {
              result: [
                'Retried after the quota backoff cleared; nothing new to report.',
                '',
                '```wake-result',
                '{ "status": "DONE" }',
                '```',
                'DONE',
              ].join('\n'),
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-91',
            };
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      const tick4Result = await tickRunner4.runTick();
      expect(tick4Result.status).toBe('processed');
      expect(runnerCallCount).toBe(4);
      const tick4RunId = (tick4Result as { runId?: string }).runId;
      expect(tick4RunId).toBeDefined();

      // The quota-retry run wasn't triggered by a fresh comment, so its own
      // reply must go to the issue sink, not the PR sink — even though the
      // projection's sticky latestComment.resourceUri still names the PR.
      // (retryUnconfirmedDeliveries may also re-attempt tick 3's still-
      // unconfirmed PR delivery during this tick; identify tick 4's own
      // intent by runId to avoid conflating the two.)
      expect(
        prSinkReceived.some(
          (event) =>
            event.sourceEventType === 'wake.publish.intent.requested' &&
            event.sourceRefs.runId === tick4RunId,
        ),
      ).toBe(false);
      const tick4GithubIntent = githubSinkReceived.find(
        (event) =>
          event.sourceEventType === 'wake.publish.intent.requested' &&
          event.sourceRefs.runId === tick4RunId,
      );
      expect(tick4GithubIntent).toBeDefined();
      expect(tick4GithubIntent?.sourceRefs.resourceUri).toBeUndefined();

      // Fix 1 regression: 'pr.comment.reply.published' (the confirmation
      // event the PR sink's deliverIntent returns on success, asserted at
      // line ~4366) must be recognized by
      // outboundConfirmationEventTypes — otherwise retryUnconfirmedDeliveries
      // never sees tick 3's PR reply as confirmed and re-delivers it on every
      // subsequent tick, forever, reposting the same comment to the real PR
      // thread with no bound. tick 4 above already re-triggered
      // retryUnconfirmedDeliveries once; a fixed implementation must not have
      // redelivered tick 3's reply during that pass.
      expect(prSinkPublished).toHaveLength(1);

      // Step 9: one more tick with no new triggering activity at all (no
      // fresh comment, no failed run to retry) — the strongest form of the
      // regression check. If the fix is missing, retryUnconfirmedDeliveries
      // finds tick 3's PR reply intent still unconfirmed and redelivers it
      // yet again here.
      const tickRunner5 = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:20:00.000Z') },
        config,
        stateStore: store,
        workSource: createWorkSourceFanIn([
          {
            source: 'fake-ticketing',
            async pollEvents() {
              return [];
            },
          },
          {
            source: 'fake-github-pr',
            async pollEvents() {
              return [];
            },
          },
        ]),
        outboundSink,
        runner: {
          async run() {
            throw new Error('no eligible work item should trigger a run on tick 5');
          },
        },
        resourceIndex,
        workspaceManager,
        artifactVerifier,
      });

      await tickRunner5.runTick();

      // Still exactly one PR-sink delivery across all five ticks: tick 3's
      // reply was never redelivered by any later tick's outbox retry.
      expect(prSinkPublished).toHaveLength(1);
    });
  });
});
