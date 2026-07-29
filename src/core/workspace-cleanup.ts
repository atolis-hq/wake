import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type { WorkspaceManager } from './contracts.js';
import type { createProjectionUpdater } from './projection-updater.js';
import type { Clock } from '../lib/clock.js';
import { WORKSPACE_CLEANED_EVENT, WORKSPACE_CLEANUP_FAILED_EVENT } from '../domain/event-types.js';
import type { IssueStateRecord, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
type ProjectionUpdater = ReturnType<typeof createProjectionUpdater>;

const TRANSCRIPT_CLEANED_AT_MARKER = '.cleaned-at';

// Cleans up per-issue workspaces and applies transcript retention once the
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

  async function markTranscriptDirectoryCleaned(
    workItemKey: string,
    cleanedAt: string,
  ): Promise<void> {
    const transcriptDir = deps.stateStore.paths.transcriptWorkDir(workItemKey);
    const transcriptDirStat = await stat(transcriptDir).catch(() => undefined);
    if (transcriptDirStat === undefined || !transcriptDirStat.isDirectory()) {
      return;
    }

    await writeFile(join(transcriptDir, TRANSCRIPT_CLEANED_AT_MARKER), `${cleanedAt}\n`, 'utf8');
  }

  async function applyTranscriptCleanupRetention(
    workItemKey: string,
    cleanedAt: string,
  ): Promise<void> {
    if (deps.config.transcripts.retentionMs === 0) {
      await rm(deps.stateStore.paths.transcriptWorkDir(workItemKey), {
        recursive: true,
        force: true,
      });
      return;
    }

    await markTranscriptDirectoryCleaned(workItemKey, cleanedAt);
  }

  async function sweepExpiredTranscriptDirs(): Promise<void> {
    const retentionMs = deps.config.transcripts.retentionMs;
    const transcriptDirs = await readdir(deps.stateStore.paths.transcriptsRoot, {
      withFileTypes: true,
    }).catch(() => []);
    const nowMs = deps.clock.now().getTime();

    for (const entry of transcriptDirs) {
      if (!entry.isDirectory()) {
        continue;
      }

      const transcriptDir = join(deps.stateStore.paths.transcriptsRoot, entry.name);
      const markerPath = join(transcriptDir, TRANSCRIPT_CLEANED_AT_MARKER);
      const marker = await readFile(markerPath, 'utf8').catch(() => undefined);
      if (marker === undefined) {
        continue;
      }

      const cleanedAtMs = Date.parse(marker.trim());
      if (!Number.isFinite(cleanedAtMs)) {
        continue;
      }

      if (nowMs - cleanedAtMs >= retentionMs) {
        await rm(transcriptDir, { recursive: true, force: true });
      }
    }
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
          await applyTranscriptCleanupRetention(projection.workItemKey, eventStampNow());
        } catch (error) {
          const failedAt = eventStampNow();
          await deps.stateStore.appendEventEnvelope(
            createEventEnvelope({
              eventId: `workspace-cleanup-failed-${projection.issue.repo.replace(/[^a-z0-9]+/gi, '-')}-${projection.issue.number}`,
              workItemKey: projection.workItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: WORKSPACE_CLEANUP_FAILED_EVENT,
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
          sourceEventType: WORKSPACE_CLEANED_EVENT,
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

  return { cleanupClosedIssueWorkspaces, sweepExpiredTranscriptDirs };
}
