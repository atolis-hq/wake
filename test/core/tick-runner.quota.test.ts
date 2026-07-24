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
import type { AgentRunResult } from '../../src/core/contracts.js';
import type { EventEnvelope, IssueStateRecord } from '../../src/domain/types.js';
import { findByIssueRef } from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('quota & routing', () => {
    async function seedImplementProjection(
      store: ReturnType<typeof createStateStore>,
      input: {
        issueNumber: number;
        context?: IssueStateRecord['context'];
        comments?: IssueStateRecord['comments'];
        latestComment?: IssueStateRecord['latestComment'];
      },
    ) {
      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: `work-01JZ${String(input.issueNumber).padStart(22, '0')}`,
        issue: {
          repo: 'atolis-hq/wake',
          number: input.issueNumber,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: `https://example.test/issues/${input.issueNumber}`,
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z',
        },
        comments: input.comments ?? [],
        latestComment: input.latestComment,
        wake: {
          stage: 'implement',
          stageHistory: [],
          recentEventIds: [],
          syncedAt: '2026-07-05T12:00:00.000Z',
          expectedEcho: { commentIds: [], labels: [] },
        },
        context: input.context ?? {},
        correlatedResources: [],
      });
    }

    function createPublishingFailureTickRunner(input: {
      store: ReturnType<typeof createStateStore>;
      clockIso: string;
      runnerResult: AgentRunResult;
      published: EventEnvelope[];
    }) {
      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      return createTickRunner({
        clock: { now: () => new Date(input.clockIso) },
        config,
        stateStore: input.store,
        workSource: {
          async pollEvents() {
            return [];
          },
        },
        outboundSink: {
          async deliverIntent({ event }) {
            if (event.sourceEventType === 'wake.publish.intent.requested') {
              input.published.push(event);
            }
            return [];
          },
        },
        runner: {
          async run() {
            return input.runnerResult;
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });
    }

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

      const events = await readFile(store.paths.eventFile('2026-07-05'), 'utf8');
      expect(events).toContain(
        '"routing":{"runnerName":"fake-light","runnerKind":"fake","tier":"light"',
      );
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

    it('suppresses a repeated infrastructure failure comment for the same failure class', async () => {
      const store = createStateStore({ wakeRoot: root });
      const published: EventEnvelope[] = [];

      await seedImplementProjection(store, { issueNumber: 303 });

      await createPublishingFailureTickRunner({
        store,
        clockIso: '2026-07-05T12:00:00.000Z',
        published,
        runnerResult: {
          result: 'Runner crashed before the agent could complete.\nFAILED',
          model: 'test-model',
          cli: 'test-cli',
          failureClass: 'infra',
        },
      }).runRunnerTick();

      const failedProjection = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 303,
      });
      expect(failedProjection?.context.lastFailureClass).toBe('infra');

      const retryComment = {
        id: 'c-retry',
        body: 'Please retry.',
        author: { login: 'maintainer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      };
      await store.writeIssueState({
        ...(failedProjection as IssueStateRecord),
        comments: [...(failedProjection?.comments ?? []), retryComment],
        latestComment: retryComment,
      });

      await createPublishingFailureTickRunner({
        store,
        clockIso: '2026-07-05T12:05:00.000Z',
        published,
        runnerResult: {
          result: 'Runner crashed before the agent could complete.\nFAILED',
          model: 'test-model',
          cli: 'test-cli',
          failureClass: 'infra',
        },
      }).runRunnerTick();

      expect(published.map((event) => event.payload.kind)).toEqual(['failure']);
    });

    it('suppresses repeated infrastructure exception comments from the runner catch path', async () => {
      const store = createStateStore({ wakeRoot: root });
      const published: EventEnvelope[] = [];

      await seedImplementProjection(store, { issueNumber: 305 });

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];
      const createThrowingRunner = (clockIso: string) =>
        createTickRunner({
          clock: { now: () => new Date(clockIso) },
          config,
          stateStore: store,
          workSource: {
            async pollEvents() {
              return [];
            },
          },
          outboundSink: {
            async deliverIntent({ event }) {
              if (event.sourceEventType === 'wake.publish.intent.requested') {
                published.push(event);
              }
              return [];
            },
          },
          runner: {
            async run() {
              throw new Error('CLI process exited early');
            },
          },
          resourceIndex: createFakeResourceIndex(),
          workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
        });

      await createThrowingRunner('2026-07-05T12:00:00.000Z').runRunnerTick();

      const failedProjection = await findByIssueRef(store, {
        repo: 'atolis-hq/wake',
        issueNumber: 305,
      });
      const retryComment = {
        id: 'c-retry-exception',
        body: 'Please retry.',
        author: { login: 'maintainer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      };
      await store.writeIssueState({
        ...(failedProjection as IssueStateRecord),
        comments: [...(failedProjection?.comments ?? []), retryComment],
        latestComment: retryComment,
      });

      await createThrowingRunner('2026-07-05T12:05:00.000Z').runRunnerTick();

      expect(published.map((event) => event.payload.kind)).toEqual(['failure']);
    });

    it('still publishes task failures even when the last failure class was also task', async () => {
      const store = createStateStore({ wakeRoot: root });
      const published: EventEnvelope[] = [];
      const retryComment = {
        id: 'c-retry-task',
        body: 'Please retry.',
        author: { login: 'maintainer' },
        createdAt: '2026-07-05T12:05:00.000Z',
        updatedAt: '2026-07-05T12:05:00.000Z',
        isBotAuthored: false,
      };

      await seedImplementProjection(store, {
        issueNumber: 304,
        comments: [retryComment],
        latestComment: retryComment,
        context: {
          lastRunId: 'run-304-1',
          lastRunSentinel: 'FAILED',
          lastFailureClass: 'task',
          lastRunAction: 'implement',
          blockedFromStage: 'implement',
        },
      });

      await createPublishingFailureTickRunner({
        store,
        clockIso: '2026-07-05T12:05:00.000Z',
        published,
        runnerResult: {
          result: 'The task still needs clarification.\nFAILED',
          model: 'test-model',
          cli: 'test-cli',
          failureClass: 'task',
        },
      }).runRunnerTick();

      expect(published.map((event) => event.payload.kind)).toEqual(['failure']);
    });
  });
});
