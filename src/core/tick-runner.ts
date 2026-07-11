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
import { maxConfiguredRunnerTimeoutMs } from '../domain/runner-routing.js';
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
    return tokenUsage.inputTokens + tokenUsage.outputTokens;
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
        ...(input.workspacePath === undefined
          ? {}
          : { workspacePath: input.workspacePath }),
      },
      derivedHints: {
        stage: input.projection.wake.stage,
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

  async function deliverOutboundEvent(event: EventEnvelope): Promise<void> {
    await deps.stateStore.appendEventEnvelope(event);
    await projectionUpdater.rebuildFromEvents([event]);

    if (deps.outboundSink === undefined) {
      return;
    }

    const deliveryEvents = await deps.outboundSink.deliverIntent({ event });
    for (const deliveryEvent of deliveryEvents) {
      await deps.stateStore.appendEventEnvelope(deliveryEvent);
    }
    await projectionUpdater.rebuildFromEvents(deliveryEvents);
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
          if (runnerResult.failureClass === 'quota') {
            const ledger = await deps.stateStore.readLedger();
            const quotaFailureCount = (ledger?.quotaFailureCount ?? 0) + 1;
            await deps.stateStore.writeLedger({
              schemaVersion: 1,
              pausedUntil: resolveQuotaPauseUntil({
                result: runnerResult.result,
                now: new Date(finishedAt),
                failureCount: quotaFailureCount,
              }),
              quotaFailureCount,
              lastQuotaFailureAt: finishedAt,
            });
          } else {
            const ledger = await deps.stateStore.readLedger();
            if ((ledger?.quotaFailureCount ?? 0) > 0) {
              await deps.stateStore.writeLedger({
                schemaVersion: 1,
                quotaFailureCount: 0,
              });
            }
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
              ...(runnerResult.failureClass === 'quota'
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
              handledCommentId: latestHumanCommentId(candidate),
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
