import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { findByIssueRef, workId } from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('outbox retry / dead-letter', () => {
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
  });
});
