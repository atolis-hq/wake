import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { WorkspaceManager } from './contracts.js';
import type { createProjectionUpdater } from './projection-updater.js';
import type { Clock } from '../lib/clock.js';
import type { IssueStateRecord, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
type ProjectionUpdater = ReturnType<typeof createProjectionUpdater>;

// Cleans up per-issue workspaces (and, unless retained, transcripts) once the
// originating issue is closed. A cleanup failure is recorded as an event and
// skipped rather than aborting the sweep.
export function createWorkspaceCleanup(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: StateStore;
  workspaceManager: WorkspaceManager;
  projectionUpdater: ProjectionUpdater;
}) {
  function eventStampNow(): string {
    return deps.clock.now().toISOString();
  }

  function isPerIssueWorkspacePath(workspacePath: string): boolean {
    const workspacesRoot = join(deps.config.paths.wakeRoot, 'workspaces');
    const rel = relative(workspacesRoot, workspacePath);
    return !rel.startsWith('..') && !isAbsolute(rel) && rel.length > 0;
  }

  async function cleanupClosedIssueWorkspaces(projections: IssueStateRecord[]): Promise<void> {
    for (const projection of projections) {
      const { workspacePath } = projection.wake;
      if (
        projection.issue.state === 'closed' &&
        workspacePath !== undefined &&
        isPerIssueWorkspacePath(workspacePath)
      ) {
        try {
          await deps.workspaceManager.cleanupWorkspace({ workspacePath });
          if (!deps.config.transcripts.retainAfterWorkspaceCleanup) {
            await rm(deps.stateStore.paths.transcriptWorkDir(projection.workItemKey), {
              recursive: true,
              force: true,
            });
          }
        } catch (error) {
          const failedAt = eventStampNow();
          await deps.stateStore.appendEventEnvelope(
            createEventEnvelope({
              eventId: `workspace-cleanup-failed-${projection.issue.repo.replace(/[^a-z0-9]+/gi, '-')}-${projection.issue.number}`,
              workItemKey: projection.workItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: 'wake.workspace.cleanup-failed',
              sourceRefs: {
                repo: projection.issue.repo,
                issueNumber: projection.issue.number,
              },
              occurredAt: failedAt,
              ingestedAt: failedAt,
              trigger: 'context-only',
              payload: {
                workspacePath,
                error: error instanceof Error ? error.message : String(error),
              },
            }),
          );
          continue;
        }
        const cleanedAt = eventStampNow();
        const cleanupEvent = createEventEnvelope({
          eventId: `workspace-cleaned-${projection.issue.repo.replace(/[^a-z0-9]+/gi, '-')}-${projection.issue.number}-${deps.clock.now().getTime()}`,
          workItemKey: projection.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.workspace.cleaned',
          sourceRefs: {
            repo: projection.issue.repo,
            issueNumber: projection.issue.number,
          },
          occurredAt: cleanedAt,
          ingestedAt: cleanedAt,
          trigger: 'immediate',
          payload: { workspacePath },
        });
        await deps.stateStore.appendEventEnvelope(cleanupEvent);
        await deps.projectionUpdater.rebuildFromEvents([cleanupEvent]);
      }
    }
  }

  return { cleanupClosedIssueWorkspaces };
}
