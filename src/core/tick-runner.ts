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
import { stageLabelForStage } from '../domain/stages.js';
import type { AgentAction, EventEnvelope, IssueStateRecord, RunRecord, WakeConfig } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';

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

    if (stage === 'failed') {
      return 'wake:status.failed';
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
    return Math.max(
      deps.config.runner.claude.timeoutMs,
      deps.config.runner.codex.timeoutMs,
    );
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
    const staleRecords = (await deps.stateStore.listRunRecords())
      .filter((record) => isStaleRunningRecord(record, now));

    for (const record of staleRecords) {
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
          nextStage: 'failed',
          runId: record.runId,
          reason: 'runner:stale-timeout',
        },
      });
      await deps.stateStore.appendEventEnvelope(runCompletedEvent);
      await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

      const projection = await deps.stateStore.readIssueState(record.repo, record.issueNumber);
      if (projection !== null) {
        await deliverOutboundEvent(
          createLabelsEvent({
            projection,
            runId: record.runId,
            statusLabel: 'wake:status.failed',
            stageLabel: stageLabelForStage('failed'),
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
        await deps.stateStore.appendEventEnvelope(
          createEventEnvelope({
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
            },
          }),
        );

        await deliverOutboundEvent(
          createLabelsEvent({
            projection: candidate,
            runId,
            statusLabel: 'wake:status.working',
            stageLabel: stageLabelForStage(candidate.wake.stage),
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
          const sentinel = parsedRunnerResult.status;
          const nextStage = lifecycle.nextStageFromSentinel(action, sentinel);
          const finishedAt = deps.clock.now().toISOString();
          const resultMetadata = {
            ...runnerResult.metadata,
            envelope: parsedRunnerResult.envelope,
            ...(parsedRunnerResult.result?.advice === undefined
              ? {}
              : { advice: parsedRunnerResult.result.advice }),
            ...(parsedRunnerResult.result?.needs === undefined
              ? {}
              : { needs: parsedRunnerResult.result.needs }),
            ...(parsedRunnerResult.result?.prUrl === undefined
              ? {}
              : { prUrl: parsedRunnerResult.result.prUrl }),
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
              ...(nextStage !== null ? { nextStage } : {}),
              runId,
              sessionId: runnerResult.session_id,
              workspacePath,
              reason: `runner:${sentinel.toLowerCase()}`,
              handledCommentId: latestHumanCommentId(candidate),
            },
          });
          await deps.stateStore.appendEventEnvelope(runCompletedEvent);
          await projectionUpdater.rebuildFromEvents([runCompletedEvent]);

          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              statusLabel: nextStage !== null ? statusLabelForStage(nextStage) : 'wake:status.failed',
              stageLabel: stageLabelForStage(nextStage ?? candidate.wake.stage),
              occurredAt: finishedAt,
            }),
          );

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
              stageLabel: stageLabelForStage(candidate.wake.stage),
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
