import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';
import { createFakeWorkspaceManager } from '../../src/adapters/fake/fake-workspace-manager.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createTickRunner } from '../../src/core/tick-runner.js';
import { workId } from './support/tick-runner-fixtures.js';

describe('tick runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-tick-runner-'));
  });

  describe('run recording & publish intents', () => {
    it('writes a running run record before invoking the runner', async () => {
      const store = createStateStore({ wakeRoot: root });
      let runFileSnapshot = '';

      const runner = {
        async run() {
          const runsRoot = join(store.paths.dataRoot, 'runs');
          const runFiles = (await readdir(runsRoot)).filter((file) => file.endsWith('.json'));
          runFileSnapshot = await readFile(join(runsRoot, runFiles[0]!), 'utf8');
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

      const snapshot = JSON.parse(runFileSnapshot);
      expect(snapshot.status).toBe('running');
      expect(snapshot.lifecycle).toBe('RUNNING');
      expect(snapshot.inputSnapshotId).toMatch(/^run-9-\d+-input$/);
      expect(snapshot.lease.leaseId).toMatch(/^lease-/);
      expect(snapshot.lease.ownerInstanceId).toMatch(/^instance-/);
      expect(snapshot.workerPid).toBe(process.pid);
      expect(typeof snapshot.workerProcessStartedAt).toBe('string');

      const inputSnapshot = await store.readRunInputSnapshot(snapshot.inputSnapshotId);
      expect(inputSnapshot?.runId).toBe(snapshot.runId);
      expect(inputSnapshot?.projection.workItemKey).toBe(snapshot.workItemKey);
      expect(inputSnapshot?.projection.issue.title).toBe('Implement');
      expect(inputSnapshot?.handledThroughEventId).toBe(
        inputSnapshot?.recentEvents.at(-1)?.eventId,
      );
      expect(inputSnapshot?.recentEvents.map((event) => event.eventId)).toContain(
        `${snapshot.runId}-claimed`,
      );
    });

    it('persists lifecycle transitions before workspace prep, runner launch, and terminal finalisation', async () => {
      const store = createStateStore({ wakeRoot: root });
      const observedLifecycles: string[] = [];

      async function observeLifecycle() {
        const [record] = await store.listRunRecords();
        observedLifecycles.push(record?.lifecycle ?? 'missing');
      }

      const config = createDefaultWakeConfig(root);
      config.sources.github.policy.requiredLabels = ['wake:implement'];

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(12),
        issue: {
          repo: 'atolis-hq/wake',
          number: 12,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/12',
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
            await observeLifecycle();
            return {
              result: 'Done\nDONE',
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-lifecycle',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: {
          async prepareWorkspace() {
            await observeLifecycle();
            return {
              workspacePath: join(root, 'workspaces', workId(12)),
              mergeConflictDetected: false,
            };
          },
          async prepareReadOnlyClone() {
            throw new Error('not used');
          },
          async recordWorkspaceBookkeeping() {
            return {
              branch: 'wake/issue-12',
              headRevision: 'fake-head',
              diffSummary: '',
              untrackedFiles: [],
              unpushedCommits: { hasUpstream: false, count: 0, commits: [] },
            };
          },
          async cleanupWorkspace() {},
        },
      });

      await tickRunner.runTick();

      const [record] = await store.listRunRecords();
      expect(observedLifecycles).toEqual(['PREPARING', 'RUNNING']);
      expect(record?.lifecycle).toBe('TERMINAL');
      expect(record?.metadata).toMatchObject({
        workspaceMode: 'branch',
        workspacePath: join(root, 'workspaces', workId(12)),
      });
    });

    it('derives last meaningful activity from normalized runtime events', async () => {
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
              number: 13,
              title: 'Implement',
              body: 'Body',
              labels: ['wake:queue'],
              comments: [],
            },
          ],
        }),
        runner: {
          async run(input) {
            await input.onRuntimeEvent?.({
              type: 'agent.process.started',
              runId: input.runId,
              workItemId: input.projection.workItemKey,
              runner: { name: 'test', kind: 'fake', cli: 'Test', model: 'test-model' },
              timestamp: '2026-07-05T12:01:00.000Z',
              payload: { pid: 123 },
            });
            await input.onRuntimeEvent?.({
              type: 'agent.progress',
              runId: input.runId,
              workItemId: input.projection.workItemKey,
              runner: { name: 'test', kind: 'fake', cli: 'Test', model: 'test-model' },
              timestamp: '2026-07-05T12:02:00.000Z',
              payload: { message: 'meaningful provider progress' },
            });
            await input.onRuntimeEvent?.({
              type: 'agent.process.exited',
              runId: input.runId,
              workItemId: input.projection.workItemKey,
              runner: { name: 'test', kind: 'fake', cli: 'Test', model: 'test-model' },
              timestamp: '2026-07-05T12:03:00.000Z',
              payload: { exitCode: 0 },
            });
            return {
              result: 'Done\nDONE',
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-runtime-events',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const [record] = await store.listRunRecords();
      expect(record?.runtimeEvents?.map((event) => [event.sequence, event.type])).toEqual([
        [0, 'agent.process.started'],
        [1, 'agent.progress'],
        [2, 'agent.process.exited'],
      ]);
      expect(record?.lastMeaningfulActivityAt).toBe('2026-07-05T12:02:00.000Z');
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

      const events = await readFile(store.paths.eventFile('2026-07-05'), 'utf8');
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
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const events = await readFile(store.paths.eventFile('2026-07-05'), 'utf8');
      expect(events).toContain('"sourceEventType":"wake.publish.intent.requested"');
      expect(events).toContain('"sourceEventType":"ticket.reply.published"');
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
              deliveredEvents.push(String(input.event.payload.workflowLabel));
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
        'wake:workflow.default',
        'wake:status.completed',
        'wake:stage.done',
        'wake:workflow.default',
      ]);
      expect(runRecords[0]?.summary).toBe(
        'Implemented. The previous CI run FAILED, but this one passed.',
      );
      expect(runRecords[0]?.metadata).toMatchObject({
        envelope: 'structured',
      });
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
          async recordWorkspaceBookkeeping() {
            throw new Error('not used');
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

      const events = await readFile(store.paths.eventFile('2026-07-05'), 'utf8');
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
      expect(completedEvent.payload).toMatchObject({
        failurePhase: 'workspace-prep',
        processStarted: false,
        workspaceChanged: false,
        retrySafety: 'SAFE_TO_RETRY',
      });

      const runsRoot = join(store.paths.dataRoot, 'runs');
      const runFiles = (await readdir(runsRoot)).filter((file) => file.endsWith('.json'));
      const runRecord = JSON.parse(await readFile(join(runsRoot, runFiles[0]!), 'utf8'));
      expect(runRecord.status).toBe('failed');
      expect(runRecord).toMatchObject({
        failurePhase: 'workspace-prep',
        processStarted: false,
        workspaceChanged: false,
        retrySafety: 'SAFE_TO_RETRY',
      });
    });

    it('blocks the run before agent launch when built-in workspace validation fails', async () => {
      const store = createStateStore({ wakeRoot: root });
      let runnerCalls = 0;

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(21),
        issue: {
          repo: 'atolis-hq/wake',
          number: 21,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/21',
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
        runner: {
          async run() {
            runnerCalls += 1;
            return { result: 'DONE', model: 'test-model', cli: 'test-cli' };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces'), {
          failValidation: true,
        }),
      });

      const result = await tickRunner.runTick();
      const [record] = await store.listRunRecords();

      expect(result.status).toBe('processed');
      expect((result as { sentinel?: string }).sentinel).toBe('FAILED');
      expect(runnerCalls).toBe(0);
      expect(record).toMatchObject({
        status: 'failed',
        failurePhase: 'workspace-validation',
        processStarted: false,
        workspaceChanged: false,
        retrySafety: 'SAFE_TO_RETRY',
      });
      expect(record?.metadata).toMatchObject({
        failureSource: 'wake-workspace-validation',
      });
    });

    it('records post-run bookkeeping failures without changing the agent outcome', async () => {
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
              number: 22,
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
              result: 'Refined\nDONE',
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-bookkeeping',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces'), {
          failBookkeeping: true,
        }),
      });

      await tickRunner.runTick();
      const [record] = await store.listRunRecords();

      expect(record?.status).toBe('completed');
      expect(record?.metadata?.workspaceBookkeeping).toMatchObject({
        status: 'failed',
        failureSource: 'wake-workspace-bookkeeping',
        error: 'fake workspace bookkeeping failed',
      });
    });

    it('records PROCESS_FAILED executionOutcome and preserves prior workflowOutcome in projection when workspace prep throws', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(30),
        issue: {
          repo: 'atolis-hq/wake',
          number: 30,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/30',
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
        context: { lastWorkflowOutcome: 'BLOCKED' },
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
          async recordWorkspaceBookkeeping() {
            throw new Error('not used');
          },
          async cleanupWorkspace() {},
        },
      });

      await tickRunner.runTick();

      const runRecords = await store.listRunRecords();
      expect(runRecords[0]?.executionOutcome).toBe('PROCESS_FAILED');
      expect(runRecords[0]?.workflowOutcome).toBeUndefined();

      const projection = await store.readIssueState(workId(30));
      expect(projection?.context.lastWorkflowOutcome).toBe('BLOCKED');
    });

    it('records COMPLETED executionOutcome and BLOCKED workflowOutcome when agent returns BLOCKED', async () => {
      const store = createStateStore({ wakeRoot: root });

      await store.writeIssueState({
        schemaVersion: 1,
        workItemKey: workId(31),
        issue: {
          repo: 'atolis-hq/wake',
          number: 31,
          title: 'Implement',
          body: 'Body',
          labels: ['wake:implement'],
          assignees: [],
          isPullRequest: false,
          state: 'open',
          url: 'https://example.test/issues/31',
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
        runner: {
          async run() {
            return {
              result: 'Cannot proceed without more information.\nBLOCKED',
              model: 'test-model',
              cli: 'test-cli',
              session_id: 'session-blocked',
            };
          },
        },
        resourceIndex: createFakeResourceIndex(),
        workspaceManager: createFakeWorkspaceManager(join(root, 'workspaces')),
      });

      await tickRunner.runTick();

      const runRecords = await store.listRunRecords();
      expect(runRecords[0]?.executionOutcome).toBe('COMPLETED');
      expect(runRecords[0]?.workflowOutcome).toBe('BLOCKED');
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
  });
});
