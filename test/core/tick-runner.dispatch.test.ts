import { beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { createUnkeyedEventEnvelope } from '../../src/lib/event-log.js';
import { StateHealthError } from '../../src/lib/state-health.js';
import {
  findByIssueRef,
  githubIssueUri,
  seededResourceIndex,
  workId,
} from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('candidate selection & action dispatch', () => {
    it('halts dispatch when authoritative projection state is corrupted', async () => {
      const store = createStateStore({ wakeRoot: root });
      let runnerCallCount = 0;
      await mkdir(join(store.paths.dataRoot, 'state'), { recursive: true });
      await writeFile(store.paths.workItemStateFile(workId(347)), '{"truncated"\n', 'utf8');

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:00:00.000Z') },
        config: createDefaultWakeConfig(root),
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        runner: {
          async run() {
            runnerCallCount += 1;
            return {
              result: 'Should not run\nDONE',
              model: 'test-model',
              cli: 'test-cli',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await expect(tickRunner.runTick()).rejects.toBeInstanceOf(StateHealthError);
      expect(runnerCallCount).toBe(0);
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

    it('skips a retry-capped failed item with an unhandled comment and dispatches the next eligible item', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      config.retry.maxFailureRetries = 3;
      const staleComment = {
        id: 'c-stale-retry',
        body: 'Please retry.',
        author: { login: 'owner' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      };
      const dispatchedIssueNumbers: number[] = [];

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(4661),
        issue: {
          repo: 'atolis-hq/wake',
          number: 4661,
          title: 'Stuck validation failure',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/4661',
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:05:00.000Z',
        },
        comments: [staleComment],
        latestComment: staleComment,
        wake: {
          stage: 'implement',
          lastRunId: 'run-4661-previous',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:05:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {
          lastRunSentinel: 'FAILED',
          lastFailureClass: 'infra',
          lastRetrySafety: 'SAFE_TO_RETRY',
          lastFailurePhase: 'workspace-validation',
          failureCount: 3,
          lastHandledCommentId: 'c-before-stale-retry',
        },
        correlatedResources: [],
      });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(4662),
        issue: {
          repo: 'atolis-hq/wake',
          number: 4662,
          title: 'Fresh eligible work',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/4662',
          createdAt: '2026-07-05T12:01:00.000Z',
          updatedAt: '2026-07-05T12:01:00.000Z',
        },
        comments: [],
        wake: {
          stage: 'implement',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:01:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: {},
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
            dispatchedIssueNumbers.push(input.projection.issue.number);
            return { result: 'Completed next item\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([4661, 4662]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runRunnerTick();

      expect(result.status).toBe('processed');
      expect(dispatchedIssueNumbers).toEqual([4662]);
      expect((await store.readIssueState(workId(4661)))?.context.lastHandledCommentId).toBe(
        'c-before-stale-retry',
      );
      expect((await store.readIssueState(workId(4662)))?.context.lastRunSentinel).toBe('DONE');
    });

    it('refreshes source state before claim and skips dispatch when the issue became ineligible', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      let runnerCallCount = 0;
      let refreshCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(346),
        issue: {
          repo: 'atolis-hq/wake',
          number: 346,
          title: 'Execute',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/346',
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

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
          async refreshForDispatch() {
            refreshCallCount += 1;
            return {
              sourceRevision: 'github:issue:atolis-hq/wake#346@2026-07-05T12:09:00.000Z',
              events: [
                {
                  schemaVersion: 1,
                  eventId: 'evt-issue-346-closed',
                  streamScope: 'global-intake',
                  direction: 'inbound',
                  sourceSystem: 'github',
                  sourceEventType: 'ticket.upsert',
                  sourceRefs: {
                    repo: 'atolis-hq/wake',
                    issueNumber: 346,
                    sourceUrl: 'https://example.test/issues/346',
                    resourceUri: githubIssueUri(346),
                  },
                  occurredAt: '2026-07-05T12:09:00.000Z',
                  ingestedAt: '2026-07-05T12:10:00.000Z',
                  trigger: 'immediate',
                  payload: {
                    ticket: {
                      repo: 'atolis-hq/wake',
                      number: 346,
                      title: 'Execute',
                      body: 'Body',
                      labels: [],
                      assignees: [],
                      isPullRequest: false,
                      state: 'closed',
                      url: 'https://example.test/issues/346',
                      createdAt: '2026-07-05T12:00:00.000Z',
                      updatedAt: '2026-07-05T12:09:00.000Z',
                    },
                  },
                },
              ],
            };
          },
        },
        runner: {
          async run() {
            runnerCallCount += 1;
            return { result: 'Should not run\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([346]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecords = await store.listRunRecords();
      const events = await store.listEventEnvelopes();
      const projection = await store.readIssueState(workId(346));

      expect(result.status).toBe('idle');
      expect(refreshCallCount).toBe(1);
      expect(runnerCallCount).toBe(0);
      expect(runRecords).toHaveLength(0);
      expect(events.some((event) => event.sourceEventType === 'wake.run.claimed')).toBe(false);
      expect(projection?.issue.state).toBe('closed');
    });

    it('persists the refreshed source revision on the run record and claim event', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(347),
        issue: {
          repo: 'atolis-hq/wake',
          number: 347,
          title: 'Execute',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/347',
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

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
          async refreshForDispatch() {
            return {
              sourceRevision: 'github:issue:atolis-hq/wake#347@2026-07-05T12:00:00.000Z',
              events: [],
            };
          },
        },
        runner: {
          async run() {
            return { result: 'Implemented\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([347]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const [runRecord] = await store.listRunRecords();
      const claimedEvent = (await store.listEventEnvelopes()).find(
        (event) => event.sourceEventType === 'wake.run.claimed',
      );

      expect(result.status).toBe('processed');
      expect(runRecord?.metadata?.sourceRevision).toBe(
        'github:issue:atolis-hq/wake#347@2026-07-05T12:00:00.000Z',
      );
      expect(claimedEvent?.payload.sourceRevision).toBe(
        'github:issue:atolis-hq/wake#347@2026-07-05T12:00:00.000Z',
      );
    });

    it('does not dispatch a frozen work item', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      let runnerCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(352),
        issue: {
          repo: 'atolis-hq/wake',
          number: 352,
          title: 'Frozen',
          body: 'Body',
          labels: ['wake:queue', 'wake:frozen'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/352',
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
          frozen: { at: '2026-07-05T12:00:00.000Z', by: 'ui' },
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
          async run() {
            runnerCallCount += 1;
            return { result: 'Should not run\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([352]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runRunnerTick();
      expect(result.status).toBe('idle');
      expect(runnerCallCount).toBe(0);
      expect(await store.listRunRecords()).toEqual([]);
    });

    it('cancels an active run when source refresh closes the work item', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      let refreshCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(349),
        issue: {
          repo: 'atolis-hq/wake',
          number: 349,
          title: 'Execute',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/349',
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

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
          async refreshForDispatch() {
            refreshCallCount += 1;
            if (refreshCallCount === 1) {
              return {
                sourceRevision: 'github:issue:atolis-hq/wake#349@2026-07-05T12:00:00.000Z',
                events: [],
              };
            }
            return {
              sourceRevision: 'github:issue:atolis-hq/wake#349@2026-07-05T12:09:00.000Z',
              events: [
                createUnkeyedEventEnvelope({
                  eventId: 'evt-issue-349-closed',
                  streamScope: 'global-intake',
                  direction: 'inbound',
                  sourceSystem: 'github',
                  sourceEventType: 'ticket.upsert',
                  sourceRefs: {
                    repo: 'atolis-hq/wake',
                    issueNumber: 349,
                    sourceUrl: 'https://example.test/issues/349',
                    resourceUri: githubIssueUri(349),
                  },
                  occurredAt: '2026-07-05T12:09:00.000Z',
                  ingestedAt: '2026-07-05T12:10:00.000Z',
                  trigger: 'immediate',
                  payload: {
                    ticket: {
                      repo: 'atolis-hq/wake',
                      number: 349,
                      title: 'Execute',
                      body: 'Body',
                      labels: ['wake:queue'],
                      assignees: [],
                      isPullRequest: false,
                      state: 'closed',
                      url: 'https://example.test/issues/349',
                      createdAt: '2026-07-05T12:00:00.000Z',
                      updatedAt: '2026-07-05T12:09:00.000Z',
                    },
                  },
                }),
              ],
            };
          },
        },
        runner: {
          async run(input) {
            return new Promise((resolve) => {
              input.cancellationSignal?.addEventListener(
                'abort',
                () =>
                  resolve({
                    result: 'Source changed while running\nFAILED',
                    model: 'test-model',
                    cli: 'test-cli',
                    failureClass: 'infra' as const,
                  }),
                { once: true },
              );
            });
          },
        },
        resourceIndex: await seededResourceIndex([349]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecord = (await store.listRunRecords())[0];
      const projection = await store.readIssueState(workId(349));

      expect(result.status).toBe('processed');
      expect(runRecord?.status).toBe('failed');
      expect(runRecord?.executionOutcome).toBe('CANCELED_BY_SOURCE_CLOSED');
      expect(runRecord?.metadata?.cancellation).toMatchObject({
        reason: 'CANCELED_BY_SOURCE_CLOSED',
        source: 'active-source-reconciliation',
      });
      expect(projection?.issue.state).toBe('closed');
    });

    it('cancels an active run when a new /interrupt comment supersedes its input snapshot', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      let refreshCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(350),
        issue: {
          repo: 'atolis-hq/wake',
          number: 350,
          title: 'Execute',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/350',
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

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
          async refreshForDispatch() {
            refreshCallCount += 1;
            if (refreshCallCount === 1) {
              return {
                sourceRevision: 'github:issue:atolis-hq/wake#350@2026-07-05T12:00:00.000Z',
                events: [],
              };
            }
            return {
              sourceRevision: 'github:issue:atolis-hq/wake#350@2026-07-05T12:09:00.000Z',
              events: [
                createUnkeyedEventEnvelope({
                  eventId: 'evt-comment-350-new',
                  streamScope: 'global-intake',
                  direction: 'inbound',
                  sourceSystem: 'github',
                  sourceEventType: 'ticket.comment.created',
                  sourceRefs: {
                    repo: 'atolis-hq/wake',
                    issueNumber: 350,
                    commentId: 'c-new',
                    sourceUrl: 'https://example.test/issues/350#issuecomment-c-new',
                    resourceUri: githubIssueUri(350),
                  },
                  occurredAt: '2026-07-05T12:09:00.000Z',
                  ingestedAt: '2026-07-05T12:10:00.000Z',
                  trigger: 'immediate',
                  payload: {
                    comment: {
                      id: 'c-new',
                      body: '/interrupt Please change direction.',
                      author: { login: 'owner' },
                      createdAt: '2026-07-05T12:09:00.000Z',
                      updatedAt: '2026-07-05T12:09:00.000Z',
                    },
                  },
                }),
              ],
            };
          },
        },
        runner: {
          async run(input) {
            return new Promise((resolve) => {
              input.cancellationSignal?.addEventListener(
                'abort',
                () =>
                  resolve({
                    result: 'Canceled after newer input arrived\nDONE',
                    model: 'test-model',
                    cli: 'test-cli',
                  }),
                { once: true },
              );
            });
          },
        },
        resourceIndex: await seededResourceIndex([350]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecord = (await store.listRunRecords())[0];
      const projection = await store.readIssueState(workId(350));
      const completionEvent = (await store.listEventEnvelopes()).find(
        (event) => event.sourceEventType === 'wake.run.completed',
      );

      expect(result.status).toBe('processed');
      expect(runRecord?.executionOutcome).toBe('CANCELED_BY_SUPERSEDING_EVENT');
      expect(runRecord?.metadata?.cancellation).toMatchObject({
        reason: 'CANCELED_BY_SUPERSEDING_EVENT',
        source: 'active-source-reconciliation',
      });
      expect(projection?.latestComment?.id).toBe('c-new');
      expect(projection?.context.lastHandledCommentId).toBeUndefined();
      expect(completionEvent?.payload.handledCommentId).toBeUndefined();
      // A canceled run must not advance stage or record a workflow outcome even
      // if the runner echoed DONE â€” the snapshot it acted on was superseded.
      expect(completionEvent?.payload.nextStage).toBeUndefined();
      expect(completionEvent?.payload.workflowOutcome).toBeUndefined();
      expect(projection?.wake.stage).toBe('implement');
    });

    it('does not cancel an active run for a plain comment without /interrupt', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      let refreshCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(351),
        issue: {
          repo: 'atolis-hq/wake',
          number: 351,
          title: 'Execute',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/351',
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

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
          async refreshForDispatch() {
            refreshCallCount += 1;
            if (refreshCallCount === 1) {
              return {
                sourceRevision: 'github:issue:atolis-hq/wake#351@2026-07-05T12:00:00.000Z',
                events: [],
              };
            }
            return {
              sourceRevision: 'github:issue:atolis-hq/wake#351@2026-07-05T12:09:00.000Z',
              events: [
                createUnkeyedEventEnvelope({
                  eventId: 'evt-comment-351-new',
                  streamScope: 'global-intake',
                  direction: 'inbound',
                  sourceSystem: 'github',
                  sourceEventType: 'ticket.comment.created',
                  sourceRefs: {
                    repo: 'atolis-hq/wake',
                    issueNumber: 351,
                    commentId: 'c-plain',
                    sourceUrl: 'https://example.test/issues/351#issuecomment-c-plain',
                    resourceUri: githubIssueUri(351),
                  },
                  occurredAt: '2026-07-05T12:09:00.000Z',
                  ingestedAt: '2026-07-05T12:10:00.000Z',
                  trigger: 'immediate',
                  payload: {
                    comment: {
                      id: 'c-plain',
                      body: 'Also please update the README once this lands.',
                      author: { login: 'owner' },
                      createdAt: '2026-07-05T12:09:00.000Z',
                      updatedAt: '2026-07-05T12:09:00.000Z',
                    },
                  },
                }),
              ],
            };
          },
        },
        runner: {
          async run() {
            // Resolves well after the first supervise-loop refresh
            // (activeRunSourceRefreshIntervalMs) so the plain comment is
            // seen mid-run and confirmed not to trigger cancellation.
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([351]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecord = (await store.listRunRecords())[0];
      const projection = await store.readIssueState(workId(351));

      expect(result.status).toBe('processed');
      expect(refreshCallCount).toBeGreaterThan(1);
      expect(runRecord?.executionOutcome).not.toBe('CANCELED_BY_SUPERSEDING_EVENT');
      expect(runRecord?.metadata?.cancellation).toBeUndefined();
      expect(projection?.latestComment?.id).toBe('c-plain');
    }, 10_000);

    it('rechecks scheduler capacity after refresh and before persisting a claim', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:queue'];
      let runnerCallCount = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(348),
        issue: {
          repo: 'atolis-hq/wake',
          number: 348,
          title: 'Execute',
          body: 'Body',
          labels: ['wake:queue'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/348',
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

      const tickRunner = createTickRunner({
        clock: { now: () => new Date('2026-07-05T12:10:00.000Z') },
        config,
        stateStore: store,
        workSource: {
          async pollEvents() {
            return [];
          },
          async refreshForDispatch() {
            await store.writeRunRecord({
              schemaVersion: 1,
              runId: 'run-existing-active',
              workItemKey: workId(999),
              repo: 'atolis-hq/wake',
              issueNumber: 999,
              action: 'implement',
              lifecycle: 'RUNNING',
              status: 'running',
              startedAt: '2026-07-05T12:09:59.000Z',
              lease: {
                leaseId: 'lease-existing-active',
                ownerInstanceId: 'other-instance',
                acquiredAt: '2026-07-05T12:09:59.000Z',
                lastRenewedAt: '2026-07-05T12:09:59.000Z',
                expiresAt: '2026-07-05T12:11:00.000Z',
              },
            });

            return {
              sourceRevision: 'github:issue:atolis-hq/wake#348@2026-07-05T12:00:00.000Z',
              events: [],
            };
          },
        },
        runner: {
          async run() {
            runnerCallCount += 1;
            return { result: 'Should not run\nDONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: await seededResourceIndex([348]),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      const result = await tickRunner.runTick();
      const runRecords = await store.listRunRecords();
      const claimedEvents = (await store.listEventEnvelopes()).filter(
        (event) => event.sourceEventType === 'wake.run.claimed',
      );

      expect(result.status).toBe('idle');
      expect(runnerCallCount).toBe(0);
      expect(runRecords.map((record) => record.runId)).toEqual(['run-existing-active']);
      expect(claimedEvents).toHaveLength(0);
    });

    it('retries the blocked-from stage after a FAILED sentinel with a fresh human reply', async () => {
      // Custom workflows make the resume target a stage-level policy decision:
      // when a FAILED/BLOCKED run gets an unhandled human reply, Wake re-runs
      // the stage recorded in context.blockedFromStage instead of trusting the
      // last action string.
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
          blockedFromStage: 'implement',
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
      expect(capturedAction).toBe('implement');
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

    it('parks a projection as workflow-changed when its stored stage is no longer configured', async () => {
      const store = createStateStore({ wakeRoot: root });
      const config = createDefaultWakeConfig(root);
      config.workflows = {
        default: {
          stages: {
            refine: {
              action: 'refine',
              workspace: 'read-only',
              runnerPool: 'light',
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
  });
});
