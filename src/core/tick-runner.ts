import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';

import { createLifecycleService } from './lifecycle-service.js';
import { createPolicyEngine } from './policy-engine.js';
import { createProjectionUpdater } from './projection-updater.js';
import type {
  AgentRunner,
  AgentRunResult,
  AgentRunTokenUsage,
  OutboundSink,
  WorkSource,
  WorkspaceManager,
} from './contracts.js';
import type { Clock } from '../lib/clock.js';
import { acquireFileLock } from '../lib/lock.js';
import { parseRunnerResult } from '../domain/schema.js';
import { maxConfiguredRunnerTimeoutMs, resolveRunnerRouting } from '../domain/runner-routing.js';
import { stageLabelForStage } from '../domain/stages.js';
import type { AgentAction, EventEnvelope, IssueStateRecord, RunRecord, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';
import { resolveQuotaPauseUntil } from './quota-backoff.js';

type ParsedRunnerResult = ReturnType<typeof parseRunnerResult>;

function latestHumanCommentId(candidate: IssueStateRecord): string | undefined {
  const human = candidate.comments.filter((c) => !c.isBotAuthored);
  return human.at(-1)?.id;
}

export function createTickRunner(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  workSource: WorkSource;
  outboundSink?: OutboundSink;
  runner: AgentRunner;
  workspaceManager: WorkspaceManager;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();
  const projectionUpdater = createProjectionUpdater({
    stateStore: deps.stateStore,
  });

  function extractTokenCount(tokenUsage: AgentRunTokenUsage | undefined): number | undefined {
    if (tokenUsage === undefined) {
      return undefined;
    }
    // Cache tokens dominate real usage and were previously dropped from this
    // total entirely, understating the reported figure by roughly an order of
    // magnitude (#135).
    return (
      tokenUsage.inputTokens +
      tokenUsage.outputTokens +
      (tokenUsage.cacheCreationInputTokens ?? 0) +
      (tokenUsage.cacheReadInputTokens ?? 0)
    );
  }

  function formatCostUsd(costUsd: number): string {
    return `$${costUsd.toFixed(costUsd < 1 ? 4 : 2)}`;
  }

  function formatDuration(startedAtStr: string, finishedAtStr: string): string | undefined {
    const startedAt = new Date(startedAtStr);
    const finishedAt = new Date(finishedAtStr);
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    if (durationMs < 0 || !isFinite(durationMs)) return undefined;

    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
      return `${minutes}m${seconds}s`;
    }
    return `${seconds}s`;
  }

  function formatTokenCount(count: number): string {
    if (count >= 1000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(0)}k`;
    }
    return String(count);
  }

  function createPublishIntentEvent(input: {
    projection: import('../domain/types.js').IssueStateRecord;
    runId: string;
    action: AgentAction;
    runnerResult: AgentRunResult;
    parsedRunnerResult: ParsedRunnerResult;
    sentinel: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
    occurredAt: string;
    workspacePath?: string;
    startedAt: string;
  }): EventEnvelope {
    const tokenCount = extractTokenCount(input.runnerResult.tokenUsage);
    const duration = formatDuration(input.startedAt, input.occurredAt);

    return createEventEnvelope({
      eventId: `${input.runId}-publish-intent`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.intent.requested',
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.runId,
      },
      occurredAt: input.occurredAt,
      ingestedAt: input.occurredAt,
      trigger: 'context-only',
      payload: {
        kind: input.sentinel === 'BLOCKED'
          ? 'question'
          : input.sentinel === 'AWAITING_APPROVAL'
            ? 'approval-request'
            : input.sentinel === 'FAILED'
              ? 'failure'
              : 'status-update',
        origin: input.projection.origin ?? 'github',
        body: input.parsedRunnerResult.body,
        action: input.action,
        runId: input.runId,
        ...(input.runnerResult.session_id === undefined
          ? {}
          : { sessionId: input.runnerResult.session_id }),
        model: input.runnerResult.model,
        cli: input.runnerResult.cli,
        ...(input.runnerResult.routing === undefined
          ? {}
          : {
              runnerName: input.runnerResult.routing.runnerName,
              runnerKind: input.runnerResult.routing.runnerKind,
              runnerTier: input.runnerResult.routing.tier,
              runnerReason: input.runnerResult.routing.reason,
            }),
        ...(duration === undefined ? {} : { duration }),
        ...(tokenCount === undefined ? {} : { tokens: formatTokenCount(tokenCount) }),
        ...(input.runnerResult.tokenUsage?.costUsd === undefined
          ? {}
          : { cost: formatCostUsd(input.runnerResult.tokenUsage.costUsd) }),
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath }),
      },
      derivedHints: {
        stage: input.sentinel === 'DONE' ? 'done' : input.projection.wake.stage,
      },
    });
  }

  function statusLabelForStage(stage: import('../domain/types.js').Stage): string {
    if (stage === 'done') {
      return 'wake:status.completed';
    }

    return 'wake:status.pending';
  }

  function createLabelsEvent(input: {
    projection: import('../domain/types.js').IssueStateRecord;
    runId: string;
    statusLabel: string;
    stageLabel: string;
    occurredAt: string;
  }): EventEnvelope {
    return createEventEnvelope({
      eventId: `${input.runId}-labels-${input.statusLabel.replace(/[^a-z0-9]+/gi, '-')}-${input.stageLabel.replace(/[^a-z0-9]+/gi, '-')}`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'outbound',
      sourceSystem: 'wake',
      sourceEventType: 'wake.labels.requested',
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.runId,
      },
      occurredAt: input.occurredAt,
      ingestedAt: input.occurredAt,
      trigger: 'context-only',
      payload: {
        statusLabel: input.statusLabel,
        stageLabel: input.stageLabel,
        origin: input.projection.origin ?? 'github',
      },
    });
  }

  function runnerTimeoutMs(): number {
    return maxConfiguredRunnerTimeoutMs(deps.config);
  }

  function isPerIssueWorkspacePath(workspacePath: string): boolean {
    const workspacesRoot = join(deps.config.paths.wakeRoot, 'workspaces');
    const rel = relative(workspacesRoot, workspacePath);
    return !rel.startsWith('..') && !isAbsolute(rel) && rel.length > 0;
  }

  async function cleanupClosedIssueWorkspaces(
    projections: import('../domain/types.js').IssueStateRecord[],
    nowIso: string,
  ): Promise<void> {
    for (const projection of projections) {
      const { workspacePath } = projection.wake;
      if (
        projection.issue.state === 'closed' &&
        workspacePath !== undefined &&
        isPerIssueWorkspacePath(workspacePath)
      ) {
        try {
          await deps.workspaceManager.cleanupWorkspace({ workspacePath });
        } catch (error) {
          await deps.stateStore.appendEventEnvelope(createEventEnvelope({
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
            occurredAt: nowIso,
            ingestedAt: nowIso,
            trigger: 'context-only',
            payload: {
              workspacePath,
              error: error instanceof Error ? error.message : String(error),
            },
          }));
          continue;
        }
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
          occurredAt: nowIso,
          ingestedAt: nowIso,
          trigger: 'immediate',
          payload: { workspacePath },
        });
        await deps.stateStore.appendEventEnvelope(cleanupEvent);
        await projectionUpdater.rebuildFromEvents([cleanupEvent]);
      }
    }
  }

  function isStaleRunningRecord(record: RunRecord, now: Date): boolean {
    if (record.status !== 'running') {
      return false;
    }

    const startedAtMs = Date.parse(record.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return true;
    }

    return now.getTime() - startedAtMs >= runnerTimeoutMs();
  }

  async function reconcileStaleRunningRecords(now: Date): Promise<void> {
    const finishedAt = now.toISOString();
    const runRecords = await deps.stateStore.listRunRecords();
    const staleRecords = runRecords
      .filter((record) => isStaleRunningRecord(record, now));

    for (const record of staleRecords) {
      const projection = await deps.stateStore.readIssueState(record.repo, record.issueNumber);
      const newerCompletedRun = runRecords.some((candidate) =>
        candidate.repo === record.repo &&
        candidate.issueNumber === record.issueNumber &&
        candidate.runId !== record.runId &&
        candidate.status !== 'running' &&
        Date.parse(candidate.startedAt) > Date.parse(record.startedAt)
      );
      if (projection?.wake.lastRunId !== record.runId || newerCompletedRun) {
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
          timeoutMs: runnerTimeoutMs(),
        },
      });

      const workItemKey = `${record.repo}#${record.issueNumber}`;
      const runCompletedEvent = createEventEnvelope({
        eventId: `${record.runId}-stale-reconciled`,
        workItemKey,
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
      await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

      const updatedProjection = await deps.stateStore.readIssueState(record.repo, record.issueNumber);
      if (updatedProjection !== null) {
        await deliverOutboundEvent(
          createLabelsEvent({
            projection: updatedProjection,
            runId: record.runId,
            statusLabel: 'wake:status.failed',
            stageLabel: stageLabelForStage(updatedProjection.wake.stage),
            occurredAt: finishedAt,
          }),
        );
      }
    }
  }

  const outboxMaxAttempts = 3;

  async function recordDeliveryFailure(intentEvent: EventEnvelope, err: unknown): Promise<void> {
    const occurredAt = deps.clock.now().toISOString();
    const failureEvent = createEventEnvelope({
      eventId: `${intentEvent.eventId}-delivery-failed-${randomUUID()}`,
      workItemKey: intentEvent.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: 'wake.publish.failed',
      sourceRefs: intentEvent.sourceRefs,
      occurredAt,
      ingestedAt: occurredAt,
      trigger: 'context-only',
      payload: {
        intentEventId: intentEvent.eventId,
        intentEventType: intentEvent.sourceEventType,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    await deps.stateStore.appendEventEnvelope(failureEvent);
    await projectionUpdater.rebuildFromEvents([failureEvent]);
  }

  // Outbound delivery (comments, labels) is attempted independently of run-outcome
  // recording: a delivery failure must never rewrite an already-recorded run result
  // (S1), and must always leave a durable, retryable trace instead of being lost
  // (E5). This never throws — failures become a `wake.publish.failed` event.
  async function attemptDelivery(event: EventEnvelope): Promise<void> {
    if (deps.outboundSink === undefined) {
      return;
    }

    try {
      const deliveryEvents = await deps.outboundSink.deliverIntent({ event });
      for (const deliveryEvent of deliveryEvents) {
        await deps.stateStore.appendEventEnvelope(deliveryEvent);
      }
      await projectionUpdater.rebuildFromEvents(deliveryEvents);

      if (deliveryEvents.length === 0) {
        // No confirmation event was produced (e.g. a no-op label update) but the
        // sink did not throw. Record that delivery was attempted successfully so
        // the outbox scan below does not retry it indefinitely.
        const confirmedAt = deps.clock.now().toISOString();
        const confirmedEvent = createEventEnvelope({
          eventId: `${event.eventId}-confirmed`,
          workItemKey: event.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.publish.confirmed',
          sourceRefs: event.sourceRefs,
          occurredAt: confirmedAt,
          ingestedAt: confirmedAt,
          trigger: 'context-only',
          payload: { intentEventId: event.eventId },
        });
        await deps.stateStore.appendEventEnvelope(confirmedEvent);
      }
    } catch (err) {
      await recordDeliveryFailure(event, err);
    }
  }

  async function deliverOutboundEvent(event: EventEnvelope): Promise<void> {
    await deps.stateStore.appendEventEnvelope(event);
    await projectionUpdater.rebuildFromEvents([event]);
    await attemptDelivery(event);
  }

  const outboundIntentEventTypes = new Set([
    'wake.publish.intent.requested',
    'wake.labels.requested',
  ]);
  const outboundConfirmationEventTypes = new Set([
    'ticket.reply.published',
    'ticket.labels.updated',
    'wake.publish.confirmed',
  ]);

  // Adopts the outbox pattern: an intent is only considered delivered once a
  // matching confirmation event exists. Anything left unconfirmed by a prior tick
  // (e.g. the process crashed mid-delivery) is retried here, bounded so a
  // permanently failing sink dead-letters instead of retrying forever.
  async function retryUnconfirmedDeliveries(): Promise<void> {
    if (deps.outboundSink === undefined) {
      return;
    }

    const events = await deps.stateStore.listEventEnvelopes();
    const confirmedIntentIds = new Set<string>();
    const failureAttempts = new Map<string, number>();

    for (const event of events) {
      const intentEventId = event.payload.intentEventId;
      if (typeof intentEventId !== 'string') {
        continue;
      }
      if (outboundConfirmationEventTypes.has(event.sourceEventType)) {
        confirmedIntentIds.add(intentEventId);
      }
      if (event.sourceEventType === 'wake.publish.failed') {
        failureAttempts.set(intentEventId, (failureAttempts.get(intentEventId) ?? 0) + 1);
      }
    }

    for (const intent of events) {
      if (!outboundIntentEventTypes.has(intent.sourceEventType)) {
        continue;
      }
      if (confirmedIntentIds.has(intent.eventId)) {
        continue;
      }
      if ((failureAttempts.get(intent.eventId) ?? 0) >= outboxMaxAttempts) {
        continue;
      }
      await attemptDelivery(intent);
    }
  }

  return {
    async runTick() {
      const lock = await acquireFileLock(deps.stateStore.paths.tickLockFile, {
        staleAfterMs: runnerTimeoutMs(),
      });
      if (!lock.acquired) {
        return { status: 'locked' as const };
      }

      try {
        const tickStartedAt = deps.clock.now();
        const nowIso = tickStartedAt.toISOString();
        await reconcileStaleRunningRecords(tickStartedAt);
        await retryUnconfirmedDeliveries();
        const inboundEvents = await deps.workSource.pollEvents();
        if (inboundEvents.length > 0) {
          for (const event of inboundEvents) {
            await deps.stateStore.appendEventEnvelope(event);
          }
          await projectionUpdater.rebuildFromEvents(inboundEvents);
        }

        const projections = await deps.stateStore.listIssueStates();
        await cleanupClosedIssueWorkspaces(projections, nowIso);

        const candidate = projections.find((issue) => {
          if (!policy.isEligible(issue, deps.config)) {
            return false;
          }

          if (issue.wake.stage === 'awaiting-approval') {
            return policy.needsWakeAction(issue);
          }

          const nextAction =
            policy.chooseAction(issue.wake.stage) ??
            policy.chooseRetryActionAfterHumanReply(issue);
          return nextAction !== null && policy.needsWakeAction(issue);
        });

        if (candidate === undefined) {
          return { status: 'idle' as const };
        }

        let action: AgentAction;

        if (candidate.wake.stage === 'awaiting-approval') {
          const approvalResolution = policy.resolveApprovalTransition(candidate);
          if (approvalResolution === null) {
            return { status: 'idle' as const };
          }

          if (approvalResolution.approved) {
            const approvalId = `approval-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const approvedAt = deps.clock.now().toISOString();
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const nextStage = lifecycle.nextStageFromSentinel(approvalResolution.pendingAction, 'DONE')!;

            const approvalCompletedEvent = createEventEnvelope({
              eventId: `${approvalId}-completed`,
              workItemKey: candidate.workItemKey,
              streamScope: 'work-item',
              direction: 'internal',
              sourceSystem: 'wake',
              sourceEventType: 'wake.run.completed',
              sourceRefs: {
                repo: candidate.issue.repo,
                issueNumber: candidate.issue.number,
                runId: approvalId,
              },
              occurredAt: approvedAt,
              ingestedAt: approvedAt,
              trigger: 'immediate',
              payload: {
                action: approvalResolution.pendingAction,
                sentinel: 'DONE',
                nextStage,
                runId: approvalId,
                reason: 'human:approved',
                handledCommentId: latestHumanCommentId(candidate),
              },
            });
            await deps.stateStore.appendEventEnvelope(approvalCompletedEvent);
            await projectionUpdater.rebuildFromEvents([approvalCompletedEvent]);

            await deliverOutboundEvent(
              createLabelsEvent({
                projection: candidate,
                runId: approvalId,
                statusLabel: statusLabelForStage(nextStage),
                stageLabel: stageLabelForStage(nextStage),
                occurredAt: approvedAt,
              }),
            );

            return {
              status: 'processed' as const,
              runId: approvalId,
              sentinel: 'DONE' as const,
              nextStage,
            };
          }

          action = approvalResolution.pendingAction;
        } else {
          const nextAction =
            policy.chooseAction(candidate.wake.stage) ??
            policy.chooseRetryActionAfterHumanReply(candidate);
          if (nextAction === null) {
            return { status: 'idle' as const };
          }
          action = nextAction;
        }

        // Resolve routing (with sideways fallback across quota-paused runners,
        // #67) before claiming a run, so a fully-paused tier costs nothing more
        // than an idle tick instead of a claimed-but-doomed run record.
        const ledgerAtStart = await deps.stateStore.readLedger();
        const routing = resolveRunnerRouting({
          config: deps.config,
          stage: candidate.wake.stage,
          action,
          now: tickStartedAt,
          ...(ledgerAtStart === null ? {} : { ledger: ledgerAtStart }),
        });
        if (routing === null) {
          return { status: 'idle' as const };
        }

        const runId = `run-${candidate.issue.number}-${deps.clock.now().getTime()}`;
        const runningRecord = {
          schemaVersion: 1 as const,
          runId,
          repo: candidate.issue.repo,
          issueNumber: candidate.issue.number,
          action,
          status: 'running' as const,
          startedAt: nowIso,
        };

        await deps.stateStore.writeRunRecord(runningRecord);
        const claimedStage = action as import('../domain/types.js').Stage;
        const claimedEvent = createEventEnvelope({
          eventId: `${runId}-claimed`,
          workItemKey: candidate.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: 'wake.run.claimed',
          sourceRefs: {
            repo: candidate.issue.repo,
            issueNumber: candidate.issue.number,
            runId,
          },
          occurredAt: nowIso,
          ingestedAt: nowIso,
          trigger: 'immediate',
          payload: {
            action,
            priorStage: candidate.wake.stage,
            claimedStage,
          },
        });
        await deps.stateStore.appendEventEnvelope(claimedEvent);
        await projectionUpdater.rebuildFromEvents([claimedEvent]);

        await deliverOutboundEvent(
          createLabelsEvent({
            projection: candidate,
            runId,
            statusLabel: 'wake:status.working',
            stageLabel: stageLabelForStage(claimedStage),
            occurredAt: nowIso,
          }),
        );

        try {
          // 'implement' gets its own branch/workspace; 'refine' only reads
          // the issue and, at most, the canonical clone read-only - it never
          // pays per-issue workspace-preparation cost.
          const { workspacePath } =
            action === 'implement'
              ? await deps.workspaceManager.prepareWorkspace({
                  repo: candidate.issue.repo,
                  issueNumber: candidate.issue.number,
                })
              : await deps.workspaceManager.prepareReadOnlyClone({
                  repo: candidate.issue.repo,
                });

          const recentEvents = await deps.stateStore.listEventEnvelopesForWorkItem(
            candidate.workItemKey,
            6,
          );
          const runnerResult = await deps.runner.run({
            action,
            projection: candidate,
            recentEvents,
            config: deps.config,
            runId,
            routing,
            ...(workspacePath === undefined ? {} : { workspacePath }),
          });
          const parsedRunnerResult = parseRunnerResult(runnerResult.result);
          const rawSentinel = parsedRunnerResult.status;
          // Coerce DONE → AWAITING_APPROVAL when the stage requires human sign-off.
          // An agent that writes DONE but was told not to skip approval has violated
          // the protocol; treat it as AWAITING_APPROVAL so the gate is enforced.
          const skipApproval = runnerResult.metadata?.skipApproval;
          const sentinel =
            rawSentinel === 'DONE' && skipApproval === false
              ? 'AWAITING_APPROVAL'
              : rawSentinel;
          const nextStage = lifecycle.nextStageFromSentinel(action, sentinel);
          const finishedAt = deps.clock.now().toISOString();
          const failedRunnerName = runnerResult.routing?.runnerName ?? routing.runnerName;
          const existingRunners = ledgerAtStart?.runners ?? {};
          if (runnerResult.failureClass === 'quota') {
            const failureCount = (existingRunners[failedRunnerName]?.failureCount ?? 0) + 1;
            const quotaPause = resolveQuotaPauseUntil({
              result: runnerResult.result,
              now: new Date(finishedAt),
              failureCount,
            });
            await deps.stateStore.writeLedger({
              schemaVersion: 1,
              runners: {
                ...existingRunners,
                [failedRunnerName]: {
                  pausedUntil: quotaPause.pausedUntil,
                  pausedUntilSource: quotaPause.source,
                  failureCount,
                  lastFailureAt: finishedAt,
                },
              },
            });
          } else if ((existingRunners[failedRunnerName]?.failureCount ?? 0) > 0) {
            await deps.stateStore.writeLedger({
              schemaVersion: 1,
              runners: {
                ...existingRunners,
                [failedRunnerName]: { failureCount: 0 },
              },
            });
          }
          const resultMetadata = {
            ...runnerResult.metadata,
            envelope: parsedRunnerResult.envelope,
            ...(runnerResult.failureClass === undefined
              ? {}
              : { failureClass: runnerResult.failureClass }),
            ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
          };

          await deps.stateStore.writeRunRecord({
            ...runningRecord,
            status:
              sentinel === 'DONE'
                ? 'completed'
                : sentinel === 'BLOCKED'
                  ? 'blocked'
                  : sentinel === 'AWAITING_APPROVAL'
                    ? 'awaiting-approval'
                    : 'failed',
            finishedAt,
            sessionId: runnerResult.session_id,
            sentinel,
            summary: parsedRunnerResult.body,
            ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
            ...(runnerResult.tokenUsage === undefined ? {} : { tokenUsage: runnerResult.tokenUsage }),
            metadata: resultMetadata,
          });

          const runCompletedEvent = createEventEnvelope({
            eventId: `${runId}-completed`,
            workItemKey: candidate.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: 'wake.run.completed',
            sourceRefs: {
              repo: candidate.issue.repo,
              issueNumber: candidate.issue.number,
              runId,
            },
            occurredAt: finishedAt,
            ingestedAt: finishedAt,
            trigger: 'immediate',
            payload: {
              action,
              sentinel,
              ...(rawSentinel !== sentinel ? { rawSentinel } : {}),
              ...(nextStage !== null ? { nextStage } : {}),
              runId,
              sessionId: runnerResult.session_id,
              sessionCli: runnerResult.cli,
              workspacePath,
              reason: `runner:${sentinel.toLowerCase()}`,
              ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
              ...(runnerResult.failureClass === undefined
                ? {}
                : { failureClass: runnerResult.failureClass }),
              // Only mark the triggering comment handled when the run reached the
              // agent and produced a real outcome. Quota/infra failures are transient
              // blips, not an answer to the human's comment — leaving handledCommentId
              // unset lets the next tick retry instead of silently eating the request (S9).
              ...(runnerResult.failureClass === 'quota' || runnerResult.failureClass === 'infra'
                ? {}
                : { handledCommentId: latestHumanCommentId(candidate) }),
              body: parsedRunnerResult.body,
              envelope: parsedRunnerResult.envelope,
            },
          });
          await deps.stateStore.appendEventEnvelope(runCompletedEvent);
          await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              statusLabel: nextStage !== null ? statusLabelForStage(nextStage) : 'wake:status.failed',
              stageLabel: stageLabelForStage(nextStage ?? claimedStage),
              occurredAt: finishedAt,
            }),
          );

          if (runnerResult.failureClass !== 'quota') {
            const publishIntent = createPublishIntentEvent({
              projection: candidate,
              runId,
              action,
              runnerResult,
              parsedRunnerResult,
              sentinel,
              occurredAt: finishedAt,
              startedAt: nowIso,
              ...(workspacePath === undefined ? {} : { workspacePath }),
            });

            await deliverOutboundEvent(publishIntent);
          }

          return {
            status: 'processed' as const,
            runId,
            sentinel,
            nextStage,
          };
        } catch (err) {
          const finishedAt = deps.clock.now().toISOString();
          const sentinel = 'FAILED' as const;

          await deps.stateStore.writeRunRecord({
            ...runningRecord,
            status: 'failed',
            finishedAt,
            sentinel,
            summary: err instanceof Error ? err.message : String(err),
            metadata: {
              failureClass: 'infra',
            },
          });

          const runCompletedEvent = createEventEnvelope({
            eventId: `${runId}-completed`,
            workItemKey: candidate.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: 'wake.run.completed',
            sourceRefs: {
              repo: candidate.issue.repo,
              issueNumber: candidate.issue.number,
              runId,
            },
            occurredAt: finishedAt,
            ingestedAt: finishedAt,
            trigger: 'immediate',
            payload: {
              action,
              sentinel,
              runId,
              reason: 'runner:infrastructure-error',
              failureClass: 'infra',
              // Deliberately omit handledCommentId: an infra blip (CLI crash, timeout,
              // network error) never reached the agent, so it isn't an answer to the
              // triggering comment. Leaving it unset lets the next tick retry the same
              // request instead of silently eating it (S9).
            },
          });
          await deps.stateStore.appendEventEnvelope(runCompletedEvent);
          await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              statusLabel: 'wake:status.failed',
              stageLabel: stageLabelForStage(claimedStage),
              occurredAt: finishedAt,
            }),
          );

          const errorMessage = err instanceof Error ? err.message : String(err);
          const infraFailureResult: import('./contracts.js').AgentRunResult = {
            result: errorMessage,
            model: 'unknown',
            cli: 'unknown',
          };
          const parsedInfraFailureResult = parseRunnerResult(infraFailureResult.result);
          const failurePublishIntent = createPublishIntentEvent({
            projection: candidate,
            runId,
            action,
            runnerResult: infraFailureResult,
            parsedRunnerResult: parsedInfraFailureResult,
            sentinel,
            occurredAt: finishedAt,
            startedAt: nowIso,
          });
          await deliverOutboundEvent(failurePublishIntent);

          return {
            status: 'processed' as const,
            runId,
            sentinel,
            nextStage: null,
          };
        }
      } finally {
        await lock.release();
      }
    },
  };
}
