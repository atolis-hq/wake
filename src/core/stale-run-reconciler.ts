import type { createProjectionUpdater } from './projection-updater.js';
import { createLabelsEvent } from './event-builders.js';
import { stageLabelForStage } from '../domain/stages.js';
import { workflowLabelForWorkflowName, workflowNameForProjection } from '../domain/workflows.js';
import type { EventEnvelope, RunRecord, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

type StateStore = ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
type ProjectionUpdater = ReturnType<typeof createProjectionUpdater>;

// Reconciles run records still marked `running` past the runner timeout: a
// record whose work item has already moved on is superseded, otherwise it is
// failed and a completion event replayed so the projection stops waiting on it.
// `deliverOutboundEvent` is injected rather than imported so this module does
// not depend on the outbox module directly.
export function createStaleRunReconciler(deps: {
  config: WakeConfig;
  stateStore: StateStore;
  projectionUpdater: ProjectionUpdater;
  runnerTimeoutMs: () => number;
  deliverOutboundEvent: (event: EventEnvelope) => Promise<void>;
}) {
  function isStaleRunningRecord(record: RunRecord, now: Date): boolean {
    if (record.status !== 'running') {
      return false;
    }

    const startedAtMs = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return true;
    }

    return now.getTime() - startedAtMs >= deps.runnerTimeoutMs();
  }

  async function reconcileStaleRunningRecords(now: Date): Promise<void> {
    const finishedAt = now.toISOString();
    const runRecords = await deps.stateStore.listRunRecords();
    const staleRecords = runRecords.filter((record) => isStaleRunningRecord(record, now));

    for (const record of staleRecords) {
      // Run records carry the work item they belong to, so this is a direct
      // O(1) read — no scan, no index, no source ambiguity. The record's
      // repo/issueNumber are representation content and take no part in it.
      const projection = await deps.stateStore.readIssueState(record.workItemKey);
      const newerCompletedRun = runRecords.some(
        (candidate) =>
          candidate.workItemKey === record.workItemKey &&
          candidate.runId !== record.runId &&
          candidate.status !== 'running' &&
          Date.parse(candidate.startedAt) > Date.parse(record.startedAt),
      );
      // Equivalent to the previous `projection?.wake.lastRunId !== record.runId`,
      // spelled out so the non-null projection is available below for its
      // workItemKey.
      if (projection === null || projection.wake.lastRunId !== record.runId || newerCompletedRun) {
        await deps.stateStore.writeRunRecord({
          ...record,
          status: 'superseded',
          finishedAt,
          summary: 'Stale running record was superseded by a newer run.',
          metadata: {
            ...record.metadata,
            reconciledBy: 'stale-running-record',
            supersededBy: projection?.wake.lastRunId,
          },
        });
        continue;
      }

      await deps.stateStore.writeRunRecord({
        ...record,
        status: 'failed',
        finishedAt,
        sentinel: 'FAILED',
        summary: `Run exceeded timeout while marked running and was reconciled by a later tick.`,
        metadata: {
          ...record.metadata,
          reconciledBy: 'stale-running-record',
          timeoutMs: deps.runnerTimeoutMs(),
        },
      });

      const runCompletedEvent = createEventEnvelope({
        eventId: `${record.runId}-stale-reconciled`,
        workItemKey: projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: 'wake.run.completed',
        sourceRefs: {
          repo: record.repo,
          issueNumber: record.issueNumber,
          runId: record.runId,
        },
        occurredAt: finishedAt,
        ingestedAt: finishedAt,
        trigger: 'immediate',
        payload: {
          action: record.action,
          sentinel: 'FAILED',
          runId: record.runId,
          reason: 'runner:stale-timeout',
          ...(record.routing === undefined ? {} : { routing: record.routing }),
        },
      });
      await deps.stateStore.appendEventEnvelope(runCompletedEvent);
      await deps.projectionUpdater.rebuildFromEvents([runCompletedEvent]);

      const updatedProjection = await deps.stateStore.readIssueState(projection.workItemKey);
      if (updatedProjection !== null) {
        await deps.deliverOutboundEvent(
          createLabelsEvent({
            projection: updatedProjection,
            runId: record.runId,
            statusLabel: 'wake:status.failed',
            stageLabel: stageLabelForStage(updatedProjection.wake.stage),
            workflowLabel: workflowLabelForWorkflowName(
              workflowNameForProjection(updatedProjection, deps.config),
            ),
            occurredAt: finishedAt,
          }),
        );
      }
    }
  }

  return { reconcileStaleRunningRecords };
}
