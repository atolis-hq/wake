import { createLifecycleService } from './lifecycle-service.js';
import { createPolicyEngine } from './policy-engine.js';
import { createProjectionUpdater } from './projection-updater.js';
import type {
  AgentRunner,
  AgentRunResult,
  ArtifactVerifier,
  OutboundSink,
  ResourceIndex,
  WorkSource,
  WorkspaceManager,
} from './contracts.js';
import type { Clock } from '../lib/clock.js';
import { acquireFileLock } from '../lib/lock.js';
import {
  CORRELATION_REGISTERED_EVENT,
  parseRunnerArtifacts,
  parseRunnerResult,
} from '../domain/schema.js';
import { maxConfiguredRunnerTimeoutMs, resolveRunnerRouting } from '../domain/runner-routing.js';
import { awaitingApprovalRunnerSentinel, stageLabelForStage } from '../domain/stages.js';
import type { AgentAction, IssueStateRecord, Stage, WakeConfig } from '../domain/types.js';
import {
  chooseAction as chooseWorkflowAction,
  isKnownWorkflowStage,
  workflowChangedBlockReason,
  workflowForProjection,
  workflowLabelForWorkflowName,
  workflowNameForProjection,
} from '../domain/workflows.js';
import { createEventEnvelope } from '../lib/event-log.js';
import { branchNameForIssue } from '../domain/branch-naming.js';
import { customCommandWorkspace, isCustomCommandAction } from '../domain/custom-commands.js';
import { resolveQuotaPauseUntil } from './quota-backoff.js';
import { createLabelsEvent, createPublishIntentEvent } from './event-builders.js';
import { createOutbox } from './outbox.js';
import { createEventResolver } from './event-resolver.js';
import { createStaleRunReconciler } from './stale-run-reconciler.js';
import { createWorkspaceCleanup } from './workspace-cleanup.js';

type TickOutcome =
  | { status: 'locked' | 'idle' }
  | {
      status: 'processed';
      runId?: string;
      sentinel?: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
      nextStage?: Stage | null;
    };

function latestHumanCommentId(candidate: IssueStateRecord): string | undefined {
  const human = candidate.comments.filter((c) => !c.isBotAuthored);
  return human.at(-1)?.id;
}

function isLateralReadOnlyAction(action: AgentAction, config: WakeConfig): boolean {
  return isCustomCommandAction(action, config);
}

export function createTickRunner(deps: {
  clock: Clock;
  config: WakeConfig;
  stateStore: ReturnType<typeof import('../adapters/fs/state-store.js').createStateStore>;
  workSource: WorkSource;
  outboundSink?: OutboundSink;
  runner: AgentRunner;
  workspaceManager: WorkspaceManager;
  // Required — see the matching note on createProjectionUpdater's
  // resourceIndex: this is durable correlation state and must never be
  // cached in process memory across ticks or silently defaulted away.
  resourceIndex: ResourceIndex;
  // Optional: verifies agent-reported PR artifacts against the real provider
  // before they're registered as correlated resources. Undefined (e.g. no
  // GitHub source configured) means artifact claims are never trusted —
  // registerReportedArtifacts becomes a no-op rather than registering
  // unverified free text.
  artifactVerifier?: ArtifactVerifier;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();
  const projectionUpdater = createProjectionUpdater({
    stateStore: deps.stateStore,
    resourceIndex: deps.resourceIndex,
    config: deps.config,
  });
  const { deliverOutboundEvent, retryUnconfirmedDeliveries } = createOutbox({
    clock: deps.clock,
    stateStore: deps.stateStore,
    projectionUpdater,
    ...(deps.outboundSink === undefined ? {} : { outboundSink: deps.outboundSink }),
  });
  const { ingestInboundEvents } = createEventResolver({
    clock: deps.clock,
    config: deps.config,
    stateStore: deps.stateStore,
    resourceIndex: deps.resourceIndex,
    projectionUpdater,
    qualifiesForMint: policy.qualifiesForMint,
  });
  const { reconcileStaleRunningRecords } = createStaleRunReconciler({
    config: deps.config,
    stateStore: deps.stateStore,
    projectionUpdater,
    runnerTimeoutMs,
    deliverOutboundEvent,
  });
  const { cleanupClosedIssueWorkspaces } = createWorkspaceCleanup({
    clock: deps.clock,
    config: deps.config,
    stateStore: deps.stateStore,
    workspaceManager: deps.workspaceManager,
    projectionUpdater,
  });

  function isAwaitingApproval(projection: IssueStateRecord): boolean {
    return projection.context.lastRunSentinel === awaitingApprovalRunnerSentinel;
  }

  function statusLabelForStage(stage: import('../domain/types.js').Stage): string {
    if (stage === 'done') {
      return 'wake:status.completed';
    }

    return 'wake:status.pending';
  }

  function statusLabelForOutcome(input: {
    sentinel: 'DONE' | 'BLOCKED' | 'FAILED' | 'AWAITING_APPROVAL';
    stage: import('../domain/types.js').Stage;
  }): string {
    if (input.sentinel === 'AWAITING_APPROVAL') {
      return 'wake:status.awaiting-approval';
    }
    if (input.sentinel === 'BLOCKED') {
      return 'wake:status.blocked';
    }
    if (input.sentinel === 'FAILED') {
      return 'wake:status.failed';
    }
    return statusLabelForStage(input.stage);
  }

  function hasLabel(projection: IssueStateRecord, label: string): boolean {
    return projection.issue.labels.includes(label);
  }

  // Closes the loop on #82's review feedback: rather than scrape a PR link
  // out of the agent's free text, the agent emits a `wake-artifacts` fence
  // (domain/schema.ts's parseRunnerArtifacts) and Wake verifies each claim
  // against the real provider before trusting it. No verifier configured (no
  // GitHub source) means no claim is ever trusted — this is a no-op, not a
  // silent "believe the agent" fallback.
  //
  // Uses a plain appendEventEnvelope + rebuildFromEvents pair, not
  // deliverOutboundEvent: wake.correlation.registered is not a publish-intent
  // type, so attemptDelivery's outbound sink call would be a no-op anyway —
  // this matches the same plain-append pattern used elsewhere for
  // internal-only events (see buildOriginCorrelationEvents' callers).
  async function registerReportedArtifacts(input: {
    projection: IssueStateRecord;
    runId: string;
    runnerResult: AgentRunResult;
    branch: string;
    occurredAt: string;
  }): Promise<void> {
    if (deps.artifactVerifier === undefined) {
      return;
    }

    const { artifacts } = parseRunnerArtifacts(input.runnerResult.result);
    for (const artifact of artifacts) {
      const verified = await deps.artifactVerifier.verify(artifact, {
        branch: input.branch,
        repo: input.projection.issue.repo,
      });
      if (verified === null) {
        continue;
      }

      const event = createEventEnvelope({
        eventId: `${input.runId}-artifact-${artifact.kind}-${verified.resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
        workItemKey: input.projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: CORRELATION_REGISTERED_EVENT,
        sourceRefs: { runId: input.runId },
        occurredAt: input.occurredAt,
        ingestedAt: input.occurredAt,
        trigger: 'context-only',
        payload: {
          resourceUri: verified.resourceUri,
          role: 'implementation',
          relation: 'primary',
          provenance: 'agent-reported',
          registeredBy: input.runId,
        },
      });
      const appended = await deps.stateStore.appendEventEnvelope(event);
      await projectionUpdater.rebuildFromEvents([appended]);
    }
  }

  // Events are stamped by reading the clock at the moment of stamping, never
  // from a frozen tick-start snapshot. `tickStartedAt` is the tick's *decision*
  // clock (policy/staleness), and reusing it to date events inverts them
  // against the work source's own poll-time ingestedAt — pollEvents() runs
  // after tickStartedAt is captured, so in production every polled upsert is
  // LATER than the tick's start. An event dated before the upsert that creates
  // the projection it folds into sorts ahead of it in rebuildFromEvents' global
  // replay, folds against `current === null`, and is silently dropped. Reading
  // per event also stays correct once ticks work items in parallel, where a
  // shared per-tick snapshot would tie every concurrent event on ingestedAt and
  // leave append order as the only discriminator.
  function eventStampNow(): string {
    return deps.clock.now().toISOString();
  }

  // The watchlist is every resource currently correlated to an open work
  // item, deduplicated by exact resourceUri. It is derived once per tick from
  // the pre-poll projection snapshot (see runTick's ordering note) and handed
  // to every configured WorkSource. Core never interprets these URIs — it's
  // each source's own job to recognize and filter down to the resourceUri
  // shapes it understands (e.g. the GitHub PR source only polls entries
  // starting with `github:pr:`, ignoring everything else, including its own
  // review-thread correlations) and never core's (CLAUDE.md: "Core compares
  // resourceUri strings for equality and never parses a locator").
  function deriveWatchlist(projections: IssueStateRecord[]): { resourceUri: string }[] {
    const seen = new Set<string>();
    const watch: { resourceUri: string }[] = [];

    for (const projection of projections) {
      if (projection.issue.state !== 'open') {
        continue;
      }
      for (const resource of projection.correlatedResources) {
        if (seen.has(resource.resourceUri)) {
          continue;
        }
        seen.add(resource.resourceUri);
        watch.push({ resourceUri: resource.resourceUri });
      }
    }

    return watch;
  }

  async function markPendingActionableIssues(projections: IssueStateRecord[]): Promise<void> {
    for (const projection of projections) {
      const statusLabel = statusLabelForStage(projection.wake.stage);
      const stageLabel = stageLabelForStage(projection.wake.stage);
      const workflowLabel = workflowLabelForWorkflowName(
        workflowNameForProjection(projection, deps.config),
      );

      if (
        policy.resolveNextEligibleAction(projection, deps.config) === null ||
        (hasLabel(projection, statusLabel) &&
          hasLabel(projection, stageLabel) &&
          hasLabel(projection, workflowLabel))
      ) {
        continue;
      }

      await deliverOutboundEvent(
        createLabelsEvent({
          projection,
          runId: `pending-${projection.workItemKey}-${deps.clock.now().getTime()}`,
          statusLabel,
          stageLabel,
          workflowLabel,
          occurredAt: eventStampNow(),
        }),
      );
    }
  }

  function runnerTimeoutMs(): number {
    return maxConfiguredRunnerTimeoutMs(deps.config);
  }

  async function parkConfigDriftedProjections(projections: IssueStateRecord[]): Promise<boolean> {
    let parked = false;

    for (const projection of projections) {
      if (projection.wake.blockReason === workflowChangedBlockReason) {
        continue;
      }

      const workflow = workflowForProjection(projection, deps.config);
      if (workflow !== null && isKnownWorkflowStage(projection.wake.stage, workflow)) {
        continue;
      }

      const occurredAt = eventStampNow();
      const eventId = `workflow-changed-${projection.workItemKey}-${deps.clock.now().getTime()}`;
      const event = createEventEnvelope({
        eventId,
        workItemKey: projection.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: 'wake.run.completed',
        sourceRefs: {
          repo: projection.issue.repo,
          issueNumber: projection.issue.number,
          runId: eventId,
        },
        occurredAt,
        ingestedAt: occurredAt,
        trigger: 'immediate',
        payload: {
          sentinel: 'BLOCKED',
          runId: eventId,
          reason: workflowChangedBlockReason,
          blockReason: workflowChangedBlockReason,
          body: `Workflow configuration changed; stored workflow or stage is no longer configured.`,
        },
      });
      await deps.stateStore.appendEventEnvelope(event);
      await projectionUpdater.rebuildFromEvents([event]);
      await deliverOutboundEvent(
        createLabelsEvent({
          projection,
          runId: eventId,
          statusLabel: 'wake:status.blocked',
          stageLabel: stageLabelForStage(projection.wake.stage),
          workflowLabel: workflowLabelForWorkflowName(
            workflowNameForProjection(projection, deps.config),
          ),
          occurredAt,
        }),
      );
      parked = true;
    }

    return parked;
  }

  async function runIntakeTick(): Promise<TickOutcome> {
    const lock = await acquireFileLock(deps.stateStore.paths.tickLockFile, {
      staleAfterMs: Math.min(runnerTimeoutMs(), 5 * 60 * 1000),
    });
    if (!lock.acquired) {
      return { status: 'locked' as const };
    }

    try {
      const tickStartedAt = deps.clock.now();
      await reconcileStaleRunningRecords(tickStartedAt);
      await retryUnconfirmedDeliveries();
      const watchlistProjections = await deps.stateStore.listIssueStates();
      const inboundEvents = await ingestInboundEvents(
        await deps.workSource.pollEvents({ watch: deriveWatchlist(watchlistProjections) }),
      );

      const projections = await deps.stateStore.listIssueStates();
      await cleanupClosedIssueWorkspaces(projections);
      if (inboundEvents.length > 0) {
        await markPendingActionableIssues(projections);
      }

      return {
        status: inboundEvents.length > 0 ? ('processed' as const) : ('idle' as const),
      };
    } finally {
      await lock.release();
    }
  }

  async function runRunnerTick(): Promise<TickOutcome> {
    const lock = await acquireFileLock(deps.stateStore.paths.runnerLockFile, {
      staleAfterMs: runnerTimeoutMs(),
    });
    if (!lock.acquired) {
      return { status: 'locked' as const };
    }

    try {
      // The tick's *decision* clock: one consistent "now" for staleness and
      // policy, so a single tick's decisions can't disagree with themselves.
      // It is deliberately NOT an event-stamping clock — see eventStampNow().
      // Its only remaining uses are the run records' startedAt (run records
      // are not events and take no part in the rebuild fold).
      const tickStartedAt = deps.clock.now();
      const nowIso = tickStartedAt.toISOString();
      await reconcileStaleRunningRecords(tickStartedAt);

      const projections = await deps.stateStore.listIssueStates();
      if (await parkConfigDriftedProjections(projections)) {
        return { status: 'processed' as const };
      }

      const candidate = projections.find(
        (issue) => policy.resolveNextEligibleAction(issue, deps.config) !== null,
      );

      if (candidate === undefined) {
        return { status: 'idle' as const };
      }

      const workflow = workflowForProjection(candidate, deps.config);
      if (workflow === null) {
        return { status: 'idle' as const };
      }
      const workflowName = workflowNameForProjection(candidate, deps.config);
      let action: AgentAction;
      let command: string | undefined;
      let claimedStage = candidate.wake.stage;
      let workspaceMode: 'none' | 'read-only' | 'branch' = 'none';

      if (isAwaitingApproval(candidate)) {
        const customCommandRequest = policy.resolveCustomCommandRequest(candidate, deps.config);

        if (customCommandRequest !== null) {
          action = customCommandRequest.action;
          command = customCommandRequest.command;
          claimedStage = candidate.wake.stage;
          workspaceMode = customCommandRequest.workspace;
        } else {
          const approvalResolution = policy.resolveApprovalTransition(candidate);

          if (approvalResolution === null) {
            const reviewAction = policy.resolvePendingReviewFeedback(candidate);
            if (reviewAction === null) {
              return { status: 'idle' as const };
            }

            action = reviewAction;
            const workflowAction = chooseWorkflowAction(candidate, workflow);
            claimedStage = workflowAction?.stage ?? candidate.wake.stage;
            workspaceMode = workflowAction?.workspace ?? 'none';
          } else if (approvalResolution.approved) {
            const approvalId = `approval-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const approvedAt = deps.clock.now().toISOString();
            const nextStage = lifecycle.nextStageFromSentinel(
              candidate.wake.stage,
              'DONE',
              workflow,
            );
            if (nextStage === null) {
              return { status: 'idle' as const };
            }

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
                workflowLabel: workflowLabelForWorkflowName(workflowName),
                occurredAt: approvedAt,
              }),
            );

            return {
              status: 'processed' as const,
              runId: approvalId,
              sentinel: 'DONE' as const,
              nextStage,
            };
          } else {
            action = approvalResolution.pendingAction;
            const workflowAction = chooseWorkflowAction(candidate, workflow);
            claimedStage = workflowAction?.stage ?? candidate.wake.stage;
            workspaceMode = workflowAction?.workspace ?? 'none';
          }
        }
      } else {
        const workflowAction = chooseWorkflowAction(candidate, workflow);
        // Retry takes priority over the stage's fresh default action.
        // chooseWorkflowAction almost always returns a non-null action for
        // any valid stage (e.g. 'implement'), so checking it first would
        // silently discard chooseRetryActionAfterHumanReply's decision
        // whenever a FAILED/BLOCKED run left a lateral action (like
        // `revise`) unfinished with a fresh human reply waiting — instead
        // of resuming that action, it would restart the stage from
        // scratch (#258 follow-up incident: a FAILED `revise` run fell
        // back to a full fresh `implement` run and lost the PR-feedback
        // context).
        const nextAction =
          policy.resolveCustomCommandRequest(candidate, deps.config)?.action ??
          policy.chooseRetryActionAfterHumanReply(candidate, workflow) ??
          workflowAction?.action ??
          null;
        if (nextAction === null) {
          return { status: 'idle' as const };
        }
        action = nextAction;
        command = policy.resolveCustomCommandRequest(candidate, deps.config)?.command;
        claimedStage = workflowAction?.stage ?? candidate.wake.stage;
        workspaceMode =
          customCommandWorkspace(action, deps.config) ?? workflowAction?.workspace ?? 'none';
      }

      // Resolve routing (with sideways fallback across quota-paused runners,
      // #67) before claiming a run, so a fully-paused tier costs nothing more
      // than an idle tick instead of a claimed-but-doomed run record.
      const ledgerAtStart = await deps.stateStore.readLedger();
      const routing = resolveRunnerRouting({
        config: deps.config,
        stage: claimedStage,
        action,
        workflowName,
        ...(command === undefined ? {} : { command }),
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
        workItemKey: candidate.workItemKey,
        repo: candidate.issue.repo,
        issueNumber: candidate.issue.number,
        action,
        status: 'running' as const,
        startedAt: nowIso,
      };

      await deps.stateStore.writeRunRecord(runningRecord);
      const claimedAt = eventStampNow();
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
        occurredAt: claimedAt,
        ingestedAt: claimedAt,
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
          workflowLabel: workflowLabelForWorkflowName(workflowName),
          occurredAt: eventStampNow(),
        }),
      );

      try {
        const prepareResult: {
          workspacePath?: string;
          mergeConflictDetected?: boolean;
          upstreamChanges?: string;
        } =
          workspaceMode === 'branch'
            ? await deps.workspaceManager.prepareWorkspace({
                workId: candidate.workItemKey,
                repo: candidate.issue.repo,
                issueNumber: candidate.issue.number,
              })
            : workspaceMode === 'read-only'
              ? await deps.workspaceManager.prepareReadOnlyClone({
                  repo: candidate.issue.repo,
                })
              : {};

        const { workspacePath } = prepareResult;
        const mergeConflictDetected =
          'mergeConflictDetected' in prepareResult ? prepareResult.mergeConflictDetected : false;
        const upstreamChanges =
          'upstreamChanges' in prepareResult && typeof prepareResult.upstreamChanges === 'string'
            ? prepareResult.upstreamChanges
            : undefined;

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
          workspaceMode,
          ...(workspacePath === undefined ? {} : { workspacePath }),
          ...(mergeConflictDetected ? { mergeConflictDetected: true } : {}),
          ...(upstreamChanges === undefined ? {} : { upstreamChanges }),
        });
        const parsedRunnerResult = parseRunnerResult(runnerResult.result);
        const rawSentinel = parsedRunnerResult.status;
        // Coerce DONE → AWAITING_APPROVAL when the stage requires human sign-off.
        // An agent that writes DONE but was told not to skip approval has violated
        // the protocol; treat it as AWAITING_APPROVAL so the gate is enforced.
        const skipApproval = runnerResult.metadata?.skipApproval;
        const sentinel =
          rawSentinel === 'DONE' && skipApproval === false ? 'AWAITING_APPROVAL' : rawSentinel;
        const nextStage =
          isLateralReadOnlyAction(action, deps.config) && sentinel === 'DONE'
            ? null
            : lifecycle.nextStageFromSentinel(claimedStage, sentinel, workflow);
        const finishedAt = deps.clock.now().toISOString();

        if (workspaceMode === 'branch') {
          await registerReportedArtifacts({
            projection: candidate,
            runId,
            runnerResult,
            branch: branchNameForIssue(candidate.issue.number),
            occurredAt: finishedAt,
          });
        }

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
            statusLabel: statusLabelForOutcome({
              sentinel,
              stage: nextStage ?? claimedStage,
            }),
            stageLabel: stageLabelForStage(nextStage ?? claimedStage),
            workflowLabel: workflowLabelForWorkflowName(workflowName),
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
            workflowLabel: workflowLabelForWorkflowName(workflowName),
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
  }

  return {
    runIntakeTick,
    runRunnerTick,
    async runTick(): Promise<TickOutcome> {
      const intakeResult = await runIntakeTick();
      if (intakeResult.status === 'locked') {
        return intakeResult;
      }

      const runnerResult = await runRunnerTick();
      return runnerResult;
    },
  };
}
