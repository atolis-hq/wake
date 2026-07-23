import { beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

  describe('workspace cleanup', () => {
    it('deletes the per-issue workspace and clears workspacePath when an issue is closed', async () => {
      const store = createStateStore({ wakeRoot: root });
      const workspacePath = join(root, 'workspaces', workId(200));
      const transcriptPath = join(
        store.paths.transcriptWorkDir(workId(200)),
        'run-200-1',
        'run-200-1.codex.implement.prompt.txt',
      );
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(store.paths.transcriptWorkDir(workId(200)), 'run-200-1'), {
        recursive: true,
      });
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
        store.paths.transcriptWorkDir(workId(204)),
        'run-204-1',
        'run-204-1.codex.implement.prompt.txt',
      );
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(store.paths.transcriptWorkDir(workId(204)), 'run-204-1'), {
        recursive: true,
      });
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
      const canonicalClonePath = store.paths.repoRoot('atolis-hq/wake');
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
  });
});
