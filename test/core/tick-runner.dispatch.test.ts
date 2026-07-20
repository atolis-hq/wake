import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
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
  });
});
