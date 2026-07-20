import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeResourceIndex } from '../../src/adapters/fake/fake-resource-index.js';
import { createStateStore } from '../../src/adapters/fs/state-store.js';
import { createDefaultWakeConfig } from '../../src/config/defaults.js';
import { createProjectionUpdater } from '../../src/core/projection-updater.js';
import { createWorkspaceCleanup } from '../../src/core/workspace-cleanup.js';
import type { WorkspaceManager } from '../../src/core/contracts.js';

const clock = { now: () => new Date('2026-07-05T12:05:00.000Z') };

function recordingWorkspaceManager(options: { throwOnCleanup?: boolean } = {}) {
  const cleaned: string[] = [];
  const manager: WorkspaceManager = {
    async prepareWorkspace() {
      return { workspacePath: '', mergeConflictDetected: false };
    },
    async prepareReadOnlyClone() {
      return { workspacePath: '' };
    },
    async cleanupWorkspace({ workspacePath }) {
      cleaned.push(workspacePath);
      if (options.throwOnCleanup) {
        throw new Error('cleanup blew up');
      }
    },
  };
  return { manager, cleaned };
}

describe('workspace cleanup', () => {
  let root: string;
  let store: ReturnType<typeof createStateStore>;

  function projection(overrides: {
    issueNumber: number;
    state: 'open' | 'closed';
    workspacePath?: string;
  }) {
    return {
      schemaVersion: 1,
      workItemKey: `work-01JZ00000000000000000${String(overrides.issueNumber).padStart(5, '0')}`,
      issue: {
        repo: 'atolis-hq/wake',
        number: overrides.issueNumber,
        title: 'Issue',
        body: 'Body',
        labels: [],
        assignees: [],
        isPullRequest: false,
        state: overrides.state,
        url: `https://example.test/issues/${overrides.issueNumber}`,
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
        ...(overrides.workspacePath === undefined
          ? {}
          : { workspacePath: overrides.workspacePath }),
      },
      context: {},
      correlatedResources: [],
    } as never;
  }

  function perIssuePath(workId: string): string {
    return join(root, 'workspaces', workId);
  }

  function cleanup(manager: WorkspaceManager) {
    const projectionUpdater = createProjectionUpdater({
      stateStore: store,
      resourceIndex: createFakeResourceIndex(),
      config: createDefaultWakeConfig(root),
    });
    return createWorkspaceCleanup({
      clock,
      config: createDefaultWakeConfig(root),
      stateStore: store,
      workspaceManager: manager,
      projectionUpdater,
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wake-cleanup-'));
    store = createStateStore({ wakeRoot: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('cleans up a per-issue workspace for a closed issue and records a cleaned event', async () => {
    const workId = 'work-01JZ00000000000000000000001';
    const workspacePath = perIssuePath(workId);
    const closed = projection({ issueNumber: 1, state: 'closed', workspacePath });
    const { manager, cleaned } = recordingWorkspaceManager();

    await cleanup(manager).cleanupClosedIssueWorkspaces([closed]);

    expect(cleaned).toEqual([workspacePath]);
    const events = await store.listEventEnvelopes();
    expect(events.some((e) => e.sourceEventType === 'wake.workspace.cleaned')).toBe(true);
  });

  it('skips an open issue', async () => {
    const workspacePath = perIssuePath('work-01JZ00000000000000000000002');
    const open = projection({ issueNumber: 2, state: 'open', workspacePath });
    const { manager, cleaned } = recordingWorkspaceManager();

    await cleanup(manager).cleanupClosedIssueWorkspaces([open]);

    expect(cleaned).toEqual([]);
  });

  it('skips a workspace path outside the per-issue workspaces root', async () => {
    const external = projection({
      issueNumber: 3,
      state: 'closed',
      workspacePath: join(root, 'somewhere-else'),
    });
    const { manager, cleaned } = recordingWorkspaceManager();

    await cleanup(manager).cleanupClosedIssueWorkspaces([external]);

    expect(cleaned).toEqual([]);
  });

  it('records a cleanup-failed event and continues when cleanup throws', async () => {
    const workId = 'work-01JZ00000000000000000000004';
    const closed = projection({
      issueNumber: 4,
      state: 'closed',
      workspacePath: perIssuePath(workId),
    });
    const { manager } = recordingWorkspaceManager({ throwOnCleanup: true });

    await cleanup(manager).cleanupClosedIssueWorkspaces([closed]);

    const events = await store.listEventEnvelopes();
    const failure = events.find((e) => e.sourceEventType === 'wake.workspace.cleanup-failed');
    expect(failure?.payload.error).toBe('cleanup blew up');
    expect(events.some((e) => e.sourceEventType === 'wake.workspace.cleaned')).toBe(false);
  });
});
