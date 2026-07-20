import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import type { EventEnvelope } from '../../src/domain/types.js';
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

  describe('approval & custom commands', () => {
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
  });
});
