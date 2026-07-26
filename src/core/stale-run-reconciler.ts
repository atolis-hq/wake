import type { createProjectionUpdater } from './projection-updater.js';
import { createLabelsEvent } from './event-builders.js';
import { RUN_COMPLETED_EVENT } from '../domain/event-types.js';
import { stageLabelForStage } from '../domain/stages.js';
import { workflowLabelForWorkflowName, workflowNameForProjection } from '../domain/workflows.js';
import type {
  EventEnvelope,
  ExecutionAttemptLifecycle,
  ExecutionOutcome,
  ExternalSideEffects,
  FailurePhase,
  IssueStateRecord,
  RetrySafety,
  RunRecord,
  WakeConfig,
} from '../domain/types.js';
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
  isRunningRecordActive?: (record: RunRecord, now: Date) => Promise<boolean>;
  deliverOutboundEvent: (event: EventEnvelope) => Promise<void>;
}) {
  function isTerminalLifecycle(lifecycle: ExecutionAttemptLifecycle): boolean {
    return lifecycle === 'TERMINAL';
  }

  function recoveryOutcomeForLifecycle(lifecycle: ExecutionAttemptLifecycle): ExecutionOutcome {
    switch (lifecycle) {
      case 'CREATED':
      case 'CLAIMED':
      case 'PREPARING':
        return 'CANCELED_BY_RECONCILIATION';
      case 'PROCESS_STARTING':
      case 'RUNNING':
      case 'FINALISING':
        return 'STALLED';
      case 'TERMINAL':
        return 'SUPERSEDED';
    }
  }

  function failurePhaseForLifecycle(lifecycle: ExecutionAttemptLifecycle): FailurePhase {
    switch (lifecycle) {
      case 'CREATED':
      case 'CLAIMED':
      case 'PREPARING':
        return 'workspace-prep';
      case 'PROCESS_STARTING':
        return 'process-starting';
      case 'RUNNING':
      case 'FINALISING':
        return 'running';
      case 'TERMINAL':
        return 'unknown';
    }
  }

  function classifyReconciledFailure(record: RunRecord): {
    failurePhase: FailurePhase;
    processStarted: boolean;
    workspaceChanged: boolean;
    externalSideEffects: ExternalSideEffects;
    retrySafety: RetrySafety;
  } {
    const processStarted =
      record.agentPid !== undefined ||
      record.agentProcessStartedAt !== undefined ||
      record.lifecycle === 'RUNNING' ||
      record.lifecycle === 'FINALISING';
    const metadata = record.metadata as Record<string, unknown> | undefined;
    const workspaceChanged = typeof metadata?.workspacePath === 'string';
    const retrySafety: RetrySafety =
      processStarted || workspaceChanged ? 'REQUIRES_RECONCILIATION' : 'SAFE_TO_RETRY';

    return {
      failurePhase: failurePhaseForLifecycle(record.lifecycle),
      processStarted,
      workspaceChanged,
      externalSideEffects: processStarted ? 'unknown' : 'none',
      retrySafety,
    };
  }

  async function staleReason(
    record: RunRecord,
    now: Date,
  ): Promise<'timeout' | 'runner-lock-not-active' | 'startup-recovery' | null> {
    if (record.status !== 'running') {
      return null;
    }

    if (isTerminalLifecycle(record.lifecycle)) {
      return null;
    }

    if (deps.isRunningRecordActive === undefined) {
      if (
        record.lifecycle !== 'CREATED' &&
        record.lifecycle !== 'CLAIMED' &&
        record.lifecycle !== 'PREPARING'
      ) {
        const startedAtMs = Date.parse(record.startedAt);
        if (!Number.isFinite(startedAtMs)) {
          return 'timeout';
        }

        return now.getTime() - startedAtMs >= deps.runnerTimeoutMs() ? 'timeout' : null;
      }

      return 'startup-recovery';
    }

    const active = await deps.isRunningRecordActive(record, now);
    if (active) {
      return null;
    }

    if (record.lifecycle === 'RUNNING' || record.lifecycle === 'PROCESS_STARTING') {
      return 'runner-lock-not-active';
    }

    return 'startup-recovery';
  }

  async function deliverRecoveredLabels(
    projection: IssueStateRecord,
    runId: string,
    finishedAt: string,
  ): Promise<void> {
    await deps.deliverOutboundEvent(
      createLabelsEvent({
        projection,
        runId,
        statusLabel: 'wake:status.failed',
        stageLabel: stageLabelForStage(projection.wake.stage),
        workflowLabel: workflowLabelForWorkflowName(
          workflowNameForProjection(projection, deps.config),
        ),
        occurredAt: finishedAt,
      }),
    );
  }

  async function recoverMissingRunRecordClaims(
    runRecords: RunRecord[],
    finishedAt: string,
  ): Promise<void> {
    const knownRunIds = new Set(runRecords.map((record) => record.runId));
    const projections = await deps.stateStore.listIssueStates();
    for (const projection of projections) {
      const runId = projection.wake.lastRunId;
      if (
        runId === undefined ||
        knownRunIds.has(runId) ||
        runRecords.some((record) => record.workItemKey === projection.workItemKey) ||
        projection.context.lastRunSentinel !== undefined
      ) {
        continue;
      }

      const event = createEventEnvelope({
        eventId: `${runId}-missing-run-record-recovered`,
        workItemKey: projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: RUN_COMPLETED_EVENT,
        sourceRefs: {
          repo: projection.issue.repo,
          issueNumber: projection.issue.number,
          runId,
        },
        occurredAt: finishedAt,
        ingestedAt: finishedAt,
        trigger: 'immediate',
        payload: {
          action: projection.context.lastRunAction,
          sentinel: 'FAILED',
          executionOutcome: 'CANCELED_BY_RECONCILIATION',
          failurePhase: 'unknown',
          processStarted: false,
          workspaceChanged: false,
          externalSideEffects: 'unknown',
          retrySafety: 'MANUAL_REVIEW_REQUIRED',
          runId,
          reason: 'runner:missing-run-record',
        },
      });
      await deps.stateStore.appendEventEnvelope(event);
      await deps.projectionUpdater.rebuildFromEvents([event]);

      const updatedProjection = await deps.stateStore.readIssueState(projection.workItemKey);
      if (updatedProjection !== null) {
        await deliverRecoveredLabels(updatedProjection, runId, finishedAt);
      }
    }
  }

  async function reconcileStaleRunningRecords(now: Date): Promise<void> {
    const finishedAt = now.toISOString();
    // Summarized: the scan below (staleReason/classifyReconciledFailure/the
    // newerCompletedRun comparison) only reads status/lifecycle/timestamps/pids
    // and metadata.workspacePath, none of which are stripped - this runs every
    // tick, so loading every run's captured stdout/raw here just to check
    // staleness on all of them was a real OOM risk. The stale ones actually
    // rewritten below re-fetch the full record first so captured output isn't
    // dropped on write.
    const runRecords = await deps.stateStore.listRunRecordSummaries();
    await recoverMissingRunRecordClaims(runRecords, finishedAt);
    const staleRecords: Array<{
      record: RunRecord;
      reason: 'timeout' | 'runner-lock-not-active' | 'startup-recovery';
    }> = [];
    for (const record of runRecords) {
      const reason = await staleReason(record, now);
      if (reason !== null) {
        staleRecords.push({ record, reason });
      }
    }

    for (const { record, reason } of staleRecords) {
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
        const fullRecord = (await deps.stateStore.readRunRecord(record.runId)) ?? record;
        await deps.stateStore.writeRunRecord({
          ...fullRecord,
          lifecycle: 'TERMINAL',
          status: 'superseded',
          finishedAt,
          executionOutcome: 'SUPERSEDED' as const,
          summary: 'Stale running record was superseded by a newer run.',
          metadata: {
            ...fullRecord.metadata,
            reconciledBy: 'stale-running-record',
            supersededBy: projection?.wake.lastRunId,
          },
        });
        continue;
      }

      const staleExecutionOutcome: ExecutionOutcome =
        reason === 'timeout' ? 'TIMED_OUT' : recoveryOutcomeForLifecycle(record.lifecycle);
      const failureContext = classifyReconciledFailure(record);
      const fullRecord = (await deps.stateStore.readRunRecord(record.runId)) ?? record;

      await deps.stateStore.writeRunRecord({
        ...fullRecord,
        lifecycle: 'TERMINAL',
        status: 'failed',
        finishedAt,
        sentinel: 'FAILED',
        executionOutcome: staleExecutionOutcome,
        ...failureContext,
        summary: `Run exceeded timeout while marked running and was reconciled by a later tick.`,
        metadata: {
          ...fullRecord.metadata,
          reconciledBy: 'stale-running-record',
          recoveryLifecycle: record.lifecycle,
          staleReason: reason,
          timeoutMs: deps.runnerTimeoutMs(),
          ...failureContext,
        },
      });

      const runCompletedEvent = createEventEnvelope({
        eventId: `${record.runId}-stale-reconciled`,
        workItemKey: projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: RUN_COMPLETED_EVENT,
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
          executionOutcome: staleExecutionOutcome,
          ...failureContext,
          runId: record.runId,
          reason:
            reason === 'timeout'
              ? 'runner:stale-timeout'
              : reason === 'startup-recovery'
                ? `runner:recover-${record.lifecycle.toLowerCase()}`
                : 'runner:orphaned-process',
          ...(record.routing === undefined ? {} : { routing: record.routing }),
        },
      });
      await deps.stateStore.appendEventEnvelope(runCompletedEvent);
      await deps.projectionUpdater.rebuildFromEvents([runCompletedEvent]);

      const updatedProjection = await deps.stateStore.readIssueState(projection.workItemKey);
      if (updatedProjection !== null) {
        await deliverRecoveredLabels(updatedProjection, record.runId, finishedAt);
      }
    }
  }

  return { reconcileStaleRunningRecords };
}
