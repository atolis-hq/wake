import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLifecycleService } from './lifecycle-service.js';
import { createPolicyEngine } from './policy-engine.js';
import { createProjectionUpdater } from './projection-updater.js';
import type {
  AgentRunner,
  AgentRunResult,
  ArtifactVerifier,
  CancellationReason,
  OutboundSink,
  PullRequestMergeActor,
  ResourceIndex,
  SourceRefreshResult,
  WorkSource,
  WorkspaceManager,
} from './contracts.js';
import type { Clock } from '../lib/clock.js';
import { acquireFileLock } from '../lib/lock.js';
import {
  CORRELATION_REGISTERED_EVENT,
  CORRELATION_PRIMARY_CONFLICT_EVENT,
  PR_AUTO_MERGE_ENABLED_EVENT,
  PR_REVIEW_APPROVED_EVENT,
  PUBLISH_INTENT_REQUESTED_EVENT,
  RUN_CLAIMED_EVENT,
  RUN_COMPLETED_EVENT,
} from '../domain/event-types.js';
import { parseRunnerArtifacts, parseRunnerResult } from '../domain/schema.js';
import { maxConfiguredRunnerTimeoutMs, resolveRunnerRouting } from '../domain/runner-routing.js';
import {
  FROZEN_WORK_ITEM_LABEL,
  isWorkItemDeleted,
  isWorkItemRunnable,
} from '../domain/work-item-lifecycle.js';
import type {
  AgentAction,
  EventEnvelope,
  ExecutionAttemptLifecycle,
  ExecutionOutcome,
  ExternalSideEffects,
  FailurePhase,
  IssueStateRecord,
  RetrySafety,
  RunnerFailureClass,
  RunRecord,
  RunInputSnapshot,
  Stage,
  WakeConfig,
  WorkflowDefinition,
  WorkflowStageDefinition,
  WorkflowOutcome,
  RuntimeEventDraft,
} from '../domain/types.js';
import { isMeaningfulRuntimeEvent } from '../domain/runtime-events.js';
import {
  chooseAction as chooseWorkflowAction,
  entryStage as workflowEntryStage,
  isKnownWorkflowStage,
  workflowChangedBlockReason,
  workflowForProjection,
  workflowNameForProjection,
} from '../domain/workflows.js';
import {
  labelsForWorkItem,
  SCHEDULED_WORKFLOW_LABEL,
  type WorkItemLabels,
} from '../domain/work-item-labels.js';
import { createEventEnvelope } from '../lib/event-log.js';
import { branchNameForIssue } from '../domain/branch-naming.js';
import { customCommandWorkspace, isCustomCommandAction } from '../domain/custom-commands.js';
import { resolveQuotaPauseUntil } from './quota-backoff.js';
import { createLabelsEvent, createPublishIntentEvent } from './event-builders.js';
import { previousMatchingSlot } from './scheduled-workflow-source.js';
import { createOutbox } from './outbox.js';
import { createEventResolver } from './event-resolver.js';
import { createStaleRunReconciler } from './stale-run-reconciler.js';
import { createWorkspaceCleanup } from './workspace-cleanup.js';
import { createAgentExecution } from './live-execution.js';
import {
  createAutonomousDecisionAuditEvent,
  workflowRevision as computeWorkflowRevision,
} from './audit-events.js';
import {
  createRunLease,
  isRunLeaseExpired,
  renewRunLease,
  runLeaseRenewalIntervalMs,
} from './run-lease.js';
import { currentProcessIdentity, processIdentityMatches } from '../lib/process-identity.js';
import { readJsonFile, writeJsonFile } from '../lib/json-file.js';
import { isMissingPathError } from '../lib/state-health.js';

type TickOutcome =
  | { status: 'locked' | 'idle' }
  | {
      status: 'processed';
      runId?: string;
      sentinel?: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
      nextStage?: Stage | null;
    };

type WatcherState = {
  schemaVersion: 1;
  key: string;
  lastDispatchedEventId?: string;
  lastDispatchedSlot?: string;
  failureCount?: number;
  updatedAt: string;
};

type WatcherDispatch = {
  projection: IssueStateRecord;
  parentWorkflowName: string;
  parentStage: string;
  watcherIndex: number;
  targetWorkflowName: string;
  trigger: { kind: 'event'; eventId: string } | { kind: 'schedule'; slot: string };
};

const prReviewApprovalMarker = '<!-- wake:pr-review-approved -->';
const prReviewChangesMarker = '<!-- wake:pr-review-changes-requested -->';
const activeRunSourceRefreshIntervalMs = 1_000;

function latestHumanCommentId(candidate: IssueStateRecord): string | undefined {
  const human = candidate.comments.filter((c) => !c.isBotAuthored);
  return human.at(-1)?.id;
}

// Matched as a token at the start of a (trimmed) line, mirroring the
// /approved and /changes commands in policy-engine.ts.
const interruptCommandPattern = /^\/interrupt\b/i;

// Plain comments during a run are additional context for the next turn, not
// a signal to abandon the current attempt - only an explicit /interrupt
// should cancel an in-flight run, per the PR #411 follow-up discussion.
function newHumanCommentsSince(
  snapshot: IssueStateRecord,
  refreshed: IssueStateRecord,
): IssueStateRecord['comments'] {
  const knownIds = new Set(snapshot.comments.map((comment) => comment.id));
  return refreshed.comments.filter(
    (comment) => !comment.isBotAuthored && !knownIds.has(comment.id),
  );
}

function requestsInterrupt(comments: IssueStateRecord['comments']): boolean {
  return comments.some((comment) =>
    comment.body.split(/\r?\n/).some((line) => interruptCommandPattern.test(line.trim())),
  );
}

function latestActionableCommentId(candidate: IssueStateRecord): string | undefined {
  const handledCommentId =
    typeof candidate.context.lastHandledCommentId === 'string'
      ? candidate.context.lastHandledCommentId
      : undefined;
  const lastBotIndex = candidate.comments.reduce((acc, comment, index) => {
    return comment.isBotAuthored ? index : acc;
  }, -1);
  const latestComment = candidate.comments.slice(lastBotIndex).at(-1);

  if (
    latestComment?.id !== handledCommentId &&
    latestComment?.isBotAuthored === true &&
    latestComment.resourceUri !== undefined &&
    latestComment.body.includes(prReviewChangesMarker)
  ) {
    return latestComment.id;
  }

  return latestHumanCommentId(candidate);
}

function projectedSourceRevision(projection: IssueStateRecord): string {
  const latestCommentUpdatedAt = projection.comments
    .map((comment) => comment.updatedAt)
    .sort()
    .at(-1);

  return latestCommentUpdatedAt === undefined
    ? `${projection.issue.repo}#${projection.issue.number}@${projection.issue.updatedAt}`
    : `${projection.issue.repo}#${projection.issue.number}@${projection.issue.updatedAt};comments@${latestCommentUpdatedAt}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function isLateralReadOnlyAction(action: AgentAction, config: WakeConfig): boolean {
  return isCustomCommandAction(action, config);
}

function isEventFromWatcherRun(event: EventEnvelope): boolean {
  return (
    typeof event.payload === 'object' &&
    event.payload !== null &&
    'watcherRun' in event.payload &&
    event.payload.watcherRun === true
  );
}

function shouldPublishRunResult(input: {
  failureClass: RunnerFailureClass | undefined;
  previousFailureClass?: unknown;
}): boolean {
  if (input.failureClass === 'quota') {
    return false;
  }

  if (input.failureClass === undefined || input.failureClass === 'task') {
    return true;
  }

  return input.failureClass !== input.previousFailureClass;
}

function hasConfirmedExternalSideEffect(projection: IssueStateRecord): boolean {
  return projection.correlatedResources.some((resource) =>
    /^[a-z0-9-]+:pr:/.test(resource.resourceUri),
  );
}

function failurePhaseForRecord(record: RunRecord): FailurePhase {
  if (record.metadata?.failureSource === 'wake-workspace-validation') {
    return 'workspace-validation';
  }

  if (record.agentPid !== undefined || record.agentProcessStartedAt !== undefined) {
    return 'running';
  }

  if (record.lifecycle === 'PROCESS_STARTING' || record.lifecycle === 'RUNNING') {
    return 'process-starting';
  }

  if (record.lifecycle === 'PREPARING') {
    return 'workspace-prep';
  }

  return 'unknown';
}

function isWorkspaceValidationFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'failureSource' in error &&
    (error as { failureSource?: unknown }).failureSource === 'wake-workspace-validation'
  );
}

function classifyFailedRun(input: {
  projection: IssueStateRecord;
  record: RunRecord;
  failureClass?: RunnerFailureClass;
  failurePhase?: FailurePhase;
  workspacePath?: string;
  envelope?: 'structured' | 'degraded' | 'missing';
  sentinel?: string;
}): {
  failurePhase: FailurePhase;
  processStarted: boolean;
  workspaceChanged: boolean;
  externalSideEffects: ExternalSideEffects;
  retrySafety: RetrySafety;
} {
  const processStarted =
    input.record.agentPid !== undefined || input.record.agentProcessStartedAt !== undefined;
  const workspaceChanged = input.workspacePath !== undefined;
  const externalSideEffects = hasConfirmedExternalSideEffect(input.projection)
    ? 'confirmed'
    : processStarted
      ? 'unknown'
      : 'none';
  const failurePhase =
    input.failurePhase ??
    ((input.envelope === 'degraded' || input.envelope === 'missing') && input.sentinel === 'FAILED'
      ? 'result-parsing'
      : failurePhaseForRecord(input.record));

  let retrySafety: RetrySafety;
  if (input.failureClass === 'task') {
    retrySafety = 'NOT_RETRYABLE';
  } else if (externalSideEffects === 'confirmed' || workspaceChanged) {
    retrySafety = 'REQUIRES_RECONCILIATION';
  } else if (processStarted) {
    retrySafety = 'SAFE_TO_RESUME';
  } else {
    retrySafety = 'SAFE_TO_RETRY';
  }

  return {
    failurePhase,
    processStarted,
    workspaceChanged,
    externalSideEffects,
    retrySafety,
  };
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
  prMergeActor?: PullRequestMergeActor;
}) {
  const policy = createPolicyEngine();
  const lifecycle = createLifecycleService();
  const projectionUpdater = createProjectionUpdater({
    stateStore: deps.stateStore,
    resourceIndex: deps.resourceIndex,
    config: deps.config,
  });
  const { deliverOutboundEvent, retryUnconfirmedDeliveries, suppressOutboundEvent } = createOutbox({
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
    isRunningRecordActive,
    deliverOutboundEvent,
  });
  const { cleanupClosedIssueWorkspaces, sweepExpiredTranscriptDirs } = createWorkspaceCleanup({
    clock: deps.clock,
    config: deps.config,
    stateStore: deps.stateStore,
    workspaceManager: deps.workspaceManager,
    projectionUpdater,
  });
  const ownerInstanceId = `instance-${process.pid}-${Date.now()}`;

  function isAwaitingApproval(projection: IssueStateRecord): boolean {
    // pendingApprovalAction persists through a changes-requested review round
    // within the same gated cycle (that fold path never touches it), so it's
    // the faithful "is this item currently gated on human sign-off" signal —
    // context.status alone flips between 'awaiting-approval' and
    // 'changes-requested' within the same gated cycle and can't be used here.
    // The lastRunSentinel fallback tolerates a projection folded before
    // pendingApprovalAction was reliably set on every gated DONE.
    return (
      typeof projection.context.pendingApprovalAction === 'string' ||
      projection.context.lastRunSentinel === 'AWAITING_APPROVAL'
    );
  }

  // Always reads the current projection at write time (never a threaded
  // local like a stale `workflowName`/`claimedStage`), so a mid-run
  // WORKFLOW_SELECTED_EVENT or freeze/schedule change can never be
  // stamped with a label reflecting a snapshot from before it took effect.
  async function currentLabelsForWorkItem(
    workItemKey: string,
    fallback: IssueStateRecord,
  ): Promise<WorkItemLabels> {
    const projection = (await deps.stateStore.readIssueState(workItemKey)) ?? fallback;
    return labelsForWorkItem(projection, deps.config);
  }

  function hasLabel(projection: IssueStateRecord, label: string): boolean {
    return projection.issue.labels.includes(label);
  }

  type ApprovedMergePolicy = NonNullable<
    NonNullable<NonNullable<WorkflowStageDefinition['watch']>[number]['onSuccess']>['merge']
  >;

  function approvedMergePolicyForStage(
    stage: WorkflowStageDefinition | undefined,
  ): ApprovedMergePolicy | null {
    // Schema defaults materialize a disabled merge block whenever onSuccess is
    // set (e.g. approve-only watchers); treat it as no merge policy at all.
    const merge =
      stage?.watch?.find((watch) => watch.onSuccess?.merge !== undefined)?.onSuccess?.merge ?? null;
    return merge !== null && (merge.approve || merge.autoMerge) ? merge : null;
  }

  function escapeRegex(input: string): string {
    return input.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }

  function globPatternMatches(pattern: string, path: string): boolean {
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(path);
  }

  function reviewerMessageFromApprovalComment(body: string): string {
    return body
      .replaceAll(prReviewApprovalMarker, '')
      .replaceAll('<!-- wake:pr-review-changes-requested -->', '')
      .trim();
  }

  async function evaluatePrMergeRisk(input: {
    projection: IssueStateRecord;
    targetResourceUri: string;
    policy: ApprovedMergePolicy;
  }): Promise<{ passed: true; filesChanged: string[] } | { passed: false; reason: string }> {
    const incumbent = await deps.resourceIndex.resolve(input.targetResourceUri);
    if (incumbent !== undefined && incumbent !== input.projection.workItemKey) {
      return {
        passed: false,
        reason: `Merge policy blocked this PR because ${input.targetResourceUri} is primary-correlated to ${incumbent}, not ${input.projection.workItemKey}.`,
      };
    }

    const blockedLabel = input.policy.blockedLabels.find((label) =>
      input.projection.issue.labels.includes(label),
    );
    if (blockedLabel !== undefined) {
      return {
        passed: false,
        reason: `Merge policy blocked this PR because the work item has blocked label "${blockedLabel}".`,
      };
    }

    if (deps.prMergeActor === undefined) {
      return {
        passed: false,
        reason: 'Merge policy blocked this PR because no pull request merge actor is configured.',
      };
    }

    const filesChanged = await deps.prMergeActor.listChangedFiles(input.targetResourceUri);
    if (
      input.policy.maxFilesChanged !== undefined &&
      filesChanged.length > input.policy.maxFilesChanged
    ) {
      return {
        passed: false,
        reason: `Merge policy blocked this PR because it changes ${filesChanged.length} files, exceeding maxFilesChanged ${input.policy.maxFilesChanged}.`,
      };
    }

    for (const pattern of input.policy.blockedPaths) {
      const blockedPath = filesChanged.find((path) => globPatternMatches(pattern, path));
      if (blockedPath !== undefined) {
        return {
          passed: false,
          reason: `Merge policy blocked this PR because changed path "${blockedPath}" matches blockedPaths pattern "${pattern}".`,
        };
      }
    }

    return { passed: true, filesChanged };
  }

  async function publishPrMergePolicyBlock(input: {
    projection: IssueStateRecord;
    approvalResolution: NonNullable<ReturnType<typeof policy.resolveApprovalTransition>>;
    reason: string;
    workflowName: string;
  }): Promise<TickOutcome> {
    const commentId = input.approvalResolution.triggeringCommentId;
    const targetResourceUri = input.approvalResolution.targetResourceUri;
    if (commentId === undefined || targetResourceUri === undefined) {
      return { status: 'idle' };
    }

    const runId = `merge-gate-blocked-${commentId.replace(/[^a-z0-9]+/gi, '-')}`;
    const occurredAt = eventStampNow();
    const blockedEvent = createEventEnvelope({
      eventId: `${runId}-completed`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: RUN_COMPLETED_EVENT,
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId,
        resourceUri: targetResourceUri,
      },
      occurredAt,
      ingestedAt: occurredAt,
      trigger: 'immediate',
      payload: {
        action: input.approvalResolution.pendingAction,
        sentinel: 'BLOCKED',
        runId,
        reason: 'pr-review-merge-policy-blocked',
        blockReason: 'pr-review-merge-policy-blocked',
        handledCommentId: commentId,
        body: input.reason,
      },
    });
    const appended = await deps.stateStore.appendEventEnvelope(blockedEvent);
    await projectionUpdater.rebuildFromEvents([appended]);

    const reviewerMessage = reviewerMessageFromApprovalComment(
      input.approvalResolution.triggeringCommentBody ?? '',
    );
    const body = [reviewerMessage, input.reason].filter((part) => part.length > 0).join('\n\n');
    await deliverOutboundEvent(
      createEventEnvelope({
        eventId: `${runId}-publish-intent`,
        workItemKey: input.projection.workItemKey,
        streamScope: 'work-item',
        direction: 'outbound',
        sourceSystem: 'wake',
        sourceEventType: PUBLISH_INTENT_REQUESTED_EVENT,
        sourceRefs: {
          repo: input.projection.issue.repo,
          issueNumber: input.projection.issue.number,
          runId,
          resourceUri: targetResourceUri,
        },
        occurredAt,
        ingestedAt: occurredAt,
        trigger: 'context-only',
        payload: {
          kind: 'question',
          origin: input.projection.origin ?? 'github',
          body,
          action: input.approvalResolution.pendingAction,
          sentinel: 'BLOCKED',
          runId,
          idempotencyKey: `${commentId}:pr-review-merge-policy-blocked`,
          deliveryState: 'PENDING',
        },
        derivedHints: { stage: input.projection.wake.stage },
      }),
    );
    await deliverOutboundEvent(
      createLabelsEvent({
        projection: input.projection,
        runId,
        ...(await currentLabelsForWorkItem(input.projection.workItemKey, input.projection)),
        occurredAt,
      }),
    );

    return {
      status: 'processed',
      runId,
      sentinel: 'BLOCKED',
      nextStage: null,
    };
  }

  function describeMergeActorError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function performApprovedPrMergeActions(input: {
    projection: IssueStateRecord;
    approvalResolution: NonNullable<ReturnType<typeof policy.resolveApprovalTransition>>;
    mergePolicy: ApprovedMergePolicy;
  }): Promise<{ blocked: false } | { blocked: true; reason: string }> {
    if (
      deps.prMergeActor === undefined ||
      input.approvalResolution.targetResourceUri === undefined ||
      input.approvalResolution.triggeringCommentId === undefined
    ) {
      return { blocked: false };
    }

    const targetResourceUri = input.approvalResolution.targetResourceUri;
    const commentId = input.approvalResolution.triggeringCommentId.replace(/[^a-z0-9]+/gi, '-');
    const reviewBody = reviewerMessageFromApprovalComment(
      input.approvalResolution.triggeringCommentBody ?? '',
    );
    // approve and autoMerge are independent: one failing doesn't stop the
    // other from being attempted. If autoMerge succeeds, a failed approval is
    // not a policy block on its own; GitHub can reject self-approval while
    // still accepting auto-merge for repos that do not require review.
    const approvalBlockedReasons: string[] = [];
    const autoMergeBlockedReasons: string[] = [];
    const approvedEventId = `pr-merge-approved-${commentId}`;
    if (
      input.mergePolicy.approve &&
      (await deps.stateStore.readEventEnvelope(approvedEventId)) === null
    ) {
      try {
        await deps.prMergeActor.approve(targetResourceUri, reviewBody);
        const occurredAt = eventStampNow();
        await deps.stateStore.appendEventEnvelope(
          createEventEnvelope({
            eventId: approvedEventId,
            workItemKey: input.projection.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: PR_REVIEW_APPROVED_EVENT,
            sourceRefs: {
              resourceUri: targetResourceUri,
              commentId: input.approvalResolution.triggeringCommentId,
            },
            occurredAt,
            ingestedAt: occurredAt,
            trigger: 'context-only',
            payload: {
              idempotencyKey: `${input.approvalResolution.triggeringCommentId}:pr-review-approval`,
            },
          }),
        );
      } catch (error) {
        approvalBlockedReasons.push(
          `Merge policy blocked the approval step: ${describeMergeActorError(error)}`,
        );
      }
    }

    const autoMergeEventId = `pr-auto-merge-enabled-${commentId}`;
    let autoMergeSucceeded = false;
    if (
      input.mergePolicy.autoMerge &&
      (await deps.stateStore.readEventEnvelope(autoMergeEventId)) === null
    ) {
      try {
        await deps.prMergeActor.enableAutoMerge(targetResourceUri, input.mergePolicy.mergeMethod);
        const occurredAt = eventStampNow();
        await deps.stateStore.appendEventEnvelope(
          createEventEnvelope({
            eventId: autoMergeEventId,
            workItemKey: input.projection.workItemKey,
            streamScope: 'work-item',
            direction: 'internal',
            sourceSystem: 'wake',
            sourceEventType: PR_AUTO_MERGE_ENABLED_EVENT,
            sourceRefs: {
              resourceUri: targetResourceUri,
              commentId: input.approvalResolution.triggeringCommentId,
            },
            occurredAt,
            ingestedAt: occurredAt,
            trigger: 'context-only',
            payload: {
              idempotencyKey: `${input.approvalResolution.triggeringCommentId}:pr-auto-merge`,
            },
          }),
        );
        autoMergeSucceeded = true;
      } catch (error) {
        autoMergeBlockedReasons.push(
          `Merge policy blocked the auto-merge step: ${describeMergeActorError(error)}`,
        );
      }
    } else if (input.mergePolicy.autoMerge) {
      autoMergeSucceeded = true;
    }

    const blockedReasons =
      autoMergeSucceeded && input.mergePolicy.autoMerge
        ? autoMergeBlockedReasons
        : [...approvalBlockedReasons, ...autoMergeBlockedReasons];
    if (blockedReasons.length > 0) {
      return { blocked: true, reason: blockedReasons.join(' ') };
    }

    // Approval failed but auto-merge covered it (e.g. GitHub rejecting
    // self-approval on the bot's own PR) - not a policy block, but the
    // failure should still leave a visible trail instead of vanishing
    // silently, since it may also be a real permissions/config problem.
    if (approvalBlockedReasons.length > 0) {
      const occurredAt = eventStampNow();
      await deliverOutboundEvent(
        createEventEnvelope({
          eventId: `pr-merge-approval-note-${commentId}`,
          workItemKey: input.projection.workItemKey,
          streamScope: 'work-item',
          direction: 'outbound',
          sourceSystem: 'wake',
          sourceEventType: PUBLISH_INTENT_REQUESTED_EVENT,
          sourceRefs: {
            repo: input.projection.issue.repo,
            issueNumber: input.projection.issue.number,
            resourceUri: targetResourceUri,
          },
          occurredAt,
          ingestedAt: occurredAt,
          trigger: 'context-only',
          payload: {
            kind: 'status-update',
            origin: input.projection.origin ?? 'github',
            body: `Approval step did not block the merge, but did not succeed on its own: ${approvalBlockedReasons.join(' ')}`,
            idempotencyKey: `${commentId}:pr-merge-approval-note`,
            deliveryState: 'PENDING',
          },
          derivedHints: { stage: input.projection.wake.stage },
        }),
      );
    }

    return { blocked: false };
  }

  // The one deterministic approval transition: /approved, wake:auto, and a
  // watcher child's onSuccess.approve all resolve a pending approval through
  // this same event shape, so replay folds them identically.
  async function applyApprovalTransition(input: {
    projection: IssueStateRecord;
    pendingAction: AgentAction;
    approvalId: string;
    approvedAt: string;
    reason: string;
    workflow: WorkflowDefinition;
    workflowName: string;
    payloadExtras?: Record<string, unknown>;
  }): Promise<{ nextStage: Stage } | null> {
    const nextStage = lifecycle.nextStageFromSentinel(
      input.projection.wake.stage,
      'DONE',
      input.workflow,
    );
    if (nextStage === null) {
      return null;
    }

    const approvalCompletedEvent = createEventEnvelope({
      eventId: `${input.approvalId}-completed`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: RUN_COMPLETED_EVENT,
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.approvalId,
      },
      occurredAt: input.approvedAt,
      ingestedAt: input.approvedAt,
      trigger: 'immediate',
      payload: {
        action: input.pendingAction,
        sentinel: 'DONE',
        nextStage,
        runId: input.approvalId,
        reason: input.reason,
        ...input.payloadExtras,
      },
    });
    await deps.stateStore.appendEventEnvelope(approvalCompletedEvent);
    await projectionUpdater.rebuildFromEvents([approvalCompletedEvent]);

    await deliverOutboundEvent(
      createLabelsEvent({
        projection: input.projection,
        runId: input.approvalId,
        ...(await currentLabelsForWorkItem(input.projection.workItemKey, input.projection)),
        occurredAt: input.approvedAt,
      }),
    );

    return { nextStage };
  }

  // Folds a human /changes reply onto the parent's context via the same
  // `changesRequested` RUN_COMPLETED payload shape a rejecting review watcher
  // uses (projection-updater.ts) — same fold, same bounding against
  // config.retry.maxChangesRequestedRetries, so a human bouncing /changes
  // repeatedly escalates to 'blocked' exactly like an auto-revise loop would.
  async function applyChangesRequestedTransition(input: {
    projection: IssueStateRecord;
    requestId: string;
    requestedAt: string;
    feedbackBody?: string;
    // Marked handled regardless of escalation — once Wake has acted on this
    // /changes reply (dispatched a revise, or escalated to blocked because
    // the retry cap was hit), it must not keep re-triggering every tick off
    // the same unhandled comment (that would re-increment the counter
    // forever instead of converging on 'blocked' once).
    triggeringCommentId?: string;
  }): Promise<{ escalated: boolean }> {
    const currentCount =
      typeof input.projection.context.changesRequestedCount === 'number' &&
      Number.isInteger(input.projection.context.changesRequestedCount)
        ? input.projection.context.changesRequestedCount
        : 0;
    const escalated = currentCount + 1 > deps.config.retry.maxChangesRequestedRetries;

    const event = createEventEnvelope({
      eventId: `${input.requestId}-changes-requested`,
      workItemKey: input.projection.workItemKey,
      streamScope: 'work-item',
      direction: 'internal',
      sourceSystem: 'wake',
      sourceEventType: RUN_COMPLETED_EVENT,
      sourceRefs: {
        repo: input.projection.issue.repo,
        issueNumber: input.projection.issue.number,
        runId: input.requestId,
      },
      occurredAt: input.requestedAt,
      ingestedAt: input.requestedAt,
      trigger: 'immediate',
      payload: {
        changesRequested: true,
        runId: input.requestId,
        reason: 'human:changes-requested',
        ...(input.feedbackBody === undefined ? {} : { reviewFeedbackBody: input.feedbackBody }),
        ...(input.triggeringCommentId === undefined
          ? {}
          : { handledCommentId: input.triggeringCommentId }),
      },
    });
    await deps.stateStore.appendEventEnvelope(event);
    await projectionUpdater.rebuildFromEvents([event]);

    return { escalated };
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
          idempotencyKey: `${input.runId}:artifact-registration:${verified.resourceUri}`,
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

  async function appendAuditEvent(
    input: Parameters<typeof createAutonomousDecisionAuditEvent>[0],
  ): Promise<void> {
    await deps.stateStore.appendEventEnvelope(createAutonomousDecisionAuditEvent(input));
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
      if (projection.issue.state !== 'open' || isWorkItemDeleted(projection)) {
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

  // Runs against every open, non-deleted item every tick (not just ones with
  // an eligible next action) so a stale label self-heals even on a parked
  // item nothing else would otherwise re-check — this is also where
  // wake:frozen/wake:scheduled-workflow get their only reconciliation
  // coverage, since freeze/unfreeze no longer writes labels inline (§6).
  async function markPendingActionableIssues(projections: IssueStateRecord[]): Promise<void> {
    const activeRunWorkItemKeys = new Set<string>();
    const now = deps.clock.now();
    for (const record of await deps.stateStore.listRunRecordSummaries()) {
      if (record.status === 'running' && (await isRunningRecordActive(record, now))) {
        activeRunWorkItemKeys.add(record.workItemKey);
      }
    }

    for (const projection of projections) {
      if (isWorkItemDeleted(projection) || activeRunWorkItemKeys.has(projection.workItemKey)) {
        continue;
      }

      const labels = labelsForWorkItem(projection, deps.config);
      const matchesDesired =
        hasLabel(projection, labels.statusLabel) &&
        hasLabel(projection, labels.stageLabel) &&
        hasLabel(projection, labels.workflowLabel) &&
        (labels.frozenLabel === undefined || hasLabel(projection, labels.frozenLabel)) &&
        (labels.scheduledLabel === undefined || hasLabel(projection, labels.scheduledLabel));
      // A toggle label (frozen/scheduled) whose desired state is "absent"
      // still needs to be checked for stray presence — the family-prefix
      // labels above don't need this since removing them is folded into
      // "does the current one match" by construction.
      const hasStrayToggleLabel =
        (labels.frozenLabel === undefined && hasLabel(projection, FROZEN_WORK_ITEM_LABEL)) ||
        (labels.scheduledLabel === undefined && hasLabel(projection, SCHEDULED_WORKFLOW_LABEL));

      if (matchesDesired && !hasStrayToggleLabel) {
        continue;
      }

      await deliverOutboundEvent(
        createLabelsEvent({
          projection,
          runId: `pending-${projection.workItemKey}-${deps.clock.now().getTime()}`,
          ...labels,
          occurredAt: eventStampNow(),
        }),
      );
    }
  }

  function runnerTimeoutMs(): number {
    return maxConfiguredRunnerTimeoutMs(deps.config);
  }

  async function promptHashForAction(action: AgentAction): Promise<string> {
    const promptsRoot = deps.config.paths.promptsRoot;
    if (promptsRoot === undefined) {
      return sha256({ action, status: 'not-configured' });
    }

    for (const suffix of ['.md', '.start.md', '.resume.md']) {
      const path = join(promptsRoot, `${action}${suffix}`);
      try {
        return `sha256:${createHash('sha256')
          .update(await readFile(path, 'utf8'))
          .digest('hex')}`;
      } catch {
        // Try the next supported prompt template name.
      }
    }

    return sha256({ action, status: 'missing' });
  }

  function triggerEventIdForRun(input: {
    watcherTrigger?: WatcherDispatch['trigger'];
    recentEvents: EventEnvelope[];
  }): string | undefined {
    if (input.watcherTrigger?.kind === 'event') {
      return input.watcherTrigger.eventId;
    }

    return input.recentEvents.at(-1)?.eventId;
  }

  async function createRunInputSnapshot(input: {
    runId: string;
    createdAt: string;
    action: AgentAction;
    workflowName: string;
    workflow: NonNullable<ReturnType<typeof workflowForProjection>>;
    claimedStage: string;
    projection: IssueStateRecord;
    recentEvents: EventEnvelope[];
    sourceRevision: string;
    routing: NonNullable<RunRecord['routing']>;
    watcherTrigger?: WatcherDispatch['trigger'];
    workspaceValidation?: unknown;
  }): Promise<RunInputSnapshot> {
    const validation =
      input.workspaceValidation !== null &&
      typeof input.workspaceValidation === 'object' &&
      !Array.isArray(input.workspaceValidation)
        ? (input.workspaceValidation as Record<string, unknown>)
        : undefined;
    const repositoryHead =
      typeof validation?.baseRevision === 'string' ? validation.baseRevision : undefined;
    const workspaceHead =
      typeof validation?.headRevision === 'string' ? validation.headRevision : undefined;
    const triggerEventId = triggerEventIdForRun({
      ...(input.watcherTrigger === undefined ? {} : { watcherTrigger: input.watcherTrigger }),
      recentEvents: input.recentEvents,
    });

    return deps.stateStore.writeRunInputSnapshot({
      schemaVersion: 1,
      snapshotId: `${input.runId}-input`,
      runId: input.runId,
      createdAt: input.createdAt,
      action: input.action,
      workflowName: input.workflowName,
      claimedStage: input.claimedStage,
      projectionVersion: input.projection.wake.syncedAt,
      sourceUpdatedAt: input.projection.issue.updatedAt,
      sourceRevision: input.sourceRevision,
      ...(triggerEventId === undefined ? {} : { triggerEventId }),
      ...(input.recentEvents.at(-1)?.eventId === undefined
        ? {}
        : { handledThroughEventId: input.recentEvents.at(-1)!.eventId }),
      workflowHash: await computeWorkflowRevision({
        config: deps.config,
        workflowName: input.workflowName,
        workflow: input.workflow,
        action: input.action,
      }),
      promptHash: await promptHashForAction(input.action),
      ...(repositoryHead === undefined ? {} : { repositoryHead }),
      ...(workspaceHead === undefined ? {} : { workspaceHead }),
      runnerConfigurationHash: sha256({
        routing: input.routing,
        runner: deps.config.runners[input.routing.runnerName],
      }),
      projection: input.projection,
      recentEvents: input.recentEvents,
    });
  }

  // Counted from durable run records (never an in-memory counter, per the
  // "tick is a pure function of durable state" invariant), so this holds
  // across process restarts and is a backstop independent of any specific
  // dispatch-eligibility bug (stuck watcher, misconfigured cron, a dedupe gap
  // not yet caught) - it caps total damage rather than preventing a cause.
  async function exceedsDispatchRateLimit(now: Date): Promise<boolean> {
    const { windowMs, maxDispatches } = deps.config.scheduler.dispatchRateLimit;
    const windowStartMs = now.getTime() - windowMs;
    const runRecords = await deps.stateStore.listRunRecordSummaries();
    const recentCount = runRecords.reduce((count, record) => {
      const startedAtMs = Date.parse(record.startedAt);
      return Number.isFinite(startedAtMs) &&
        startedAtMs >= windowStartMs &&
        startedAtMs <= now.getTime()
        ? count + 1
        : count;
    }, 0);
    return recentCount >= maxDispatches;
  }

  function cancellationReasonForIneligibleProjection(
    projection: IssueStateRecord | null,
  ): CancellationReason {
    if (projection === null || projection.issue.state !== 'open') {
      return 'CANCELED_BY_SOURCE_CLOSED';
    }

    const requiredAssignees = deps.config.sources.github.policy.requiredAssignees;
    if (
      requiredAssignees.length > 0 &&
      !requiredAssignees.some((login) => projection.issue.assignees.includes(login))
    ) {
      return 'CANCELED_BY_UNASSIGNMENT';
    }

    const workflow = workflowForProjection(projection, deps.config);
    if (workflow === null || !isKnownWorkflowStage(projection.wake.stage, workflow)) {
      return 'CANCELED_BY_WORKFLOW_CHANGE';
    }

    return 'CANCELED_BY_SUPERSEDING_EVENT';
  }

  async function isRunningRecordActive(record: RunRecord, now: Date): Promise<boolean> {
    if (record.lease !== undefined && !isRunLeaseExpired(record, now)) {
      return true;
    }

    return (
      processIdentityMatches({
        pid: record.agentPid,
        processStartedAt: record.agentProcessStartedAt,
      }) ||
      processIdentityMatches({
        pid: record.workerPid,
        processStartedAt: record.workerProcessStartedAt,
      })
    );
  }

  async function hasSchedulerCapacity(now: Date): Promise<boolean> {
    const runRecords = await deps.stateStore.listRunRecordSummaries();
    for (const record of runRecords) {
      if (record.status !== 'running') {
        continue;
      }
      if (await isRunningRecordActive(record, now)) {
        return false;
      }
    }

    return true;
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
        sourceEventType: RUN_COMPLETED_EVENT,
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
          ...(await currentLabelsForWorkItem(projection.workItemKey, projection)),
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
      for (const event of inboundEvents) {
        const trigger = event.payload.trigger as Record<string, unknown> | undefined;
        const workflowName =
          typeof event.payload.workflow === 'string' ? event.payload.workflow : undefined;
        const workflow =
          workflowName === undefined ? undefined : deps.config.workflows[workflowName];
        if (trigger?.kind !== 'schedule' || workflowName === undefined || workflow === undefined) {
          continue;
        }
        const timestamp = eventStampNow();
        await appendAuditEvent({
          eventId: `${event.eventId}-audit-trigger-fired`,
          decisionType: 'trigger.fired',
          workItemKey: event.workItemKey,
          runId: event.eventId,
          workflowRevision: await computeWorkflowRevision({
            config: deps.config,
            workflowName,
            workflow,
          }),
          inputsConsidered: {
            workflow: workflowName,
            schedule: workflow.trigger?.schedule,
            trigger,
            sourceEventId: event.eventId,
          },
          outcome: {
            fired: true,
            sourceEventType: event.sourceEventType,
          },
          timestamp,
          sourceRefs: event.sourceRefs,
        });
      }

      const projections = await deps.stateStore.listIssueStates();
      await cleanupClosedIssueWorkspaces(projections);
      await sweepExpiredTranscriptDirs();
      // Runs every tick, not only when this tick happened to poll a fresh
      // inbound event — a stale label on a parked item (nothing else ever
      // re-checks it once there's no next action) otherwise never self-heals.
      await markPendingActionableIssues(projections);

      return {
        status: inboundEvents.length > 0 ? ('processed' as const) : ('idle' as const),
      };
    } finally {
      await lock.release();
    }
  }

  function watcherStatus(projection: IssueStateRecord): string {
    const sentinel = projection.context.lastRunSentinel;
    if (isAwaitingApproval(projection)) return 'awaiting-approval';
    if (sentinel === 'REJECTED') return 'rejected';
    if (sentinel === 'BLOCKED') return 'blocked';
    if (sentinel === 'FAILED') return 'failed';
    if (sentinel === 'DONE') return 'done';
    return 'pending';
  }

  function watcherKey(input: {
    workItemKey: string;
    parentWorkflowName: string;
    parentStage: string;
    watcherIndex: number;
  }): string {
    return [
      input.workItemKey,
      input.parentWorkflowName,
      input.parentStage,
      String(input.watcherIndex),
    ]
      .join('__')
      .replace(/[^A-Za-z0-9._-]/g, '_');
  }

  function watcherStateFile(key: string): string {
    return join(deps.stateStore.paths.dataRoot, 'watchers', `${key}.json`);
  }

  async function readWatcherState(key: string): Promise<WatcherState | null> {
    try {
      const raw = await readJsonFile<unknown>(watcherStateFile(key));
      if (raw === null || typeof raw !== 'object') return null;
      const record = raw as Partial<WatcherState>;
      return record.schemaVersion === 1 &&
        record.key === key &&
        typeof record.updatedAt === 'string'
        ? {
            schemaVersion: 1,
            key,
            ...(typeof record.lastDispatchedEventId === 'string'
              ? { lastDispatchedEventId: record.lastDispatchedEventId }
              : {}),
            ...(typeof record.lastDispatchedSlot === 'string'
              ? { lastDispatchedSlot: record.lastDispatchedSlot }
              : {}),
            ...(typeof record.failureCount === 'number' &&
            Number.isInteger(record.failureCount) &&
            record.failureCount >= 0
              ? { failureCount: record.failureCount }
              : {}),
            updatedAt: record.updatedAt,
          }
        : null;
    } catch (error) {
      if (isMissingPathError(error)) return null;
      throw error;
    }
  }

  async function writeWatcherState(key: string, patch: Partial<WatcherState>): Promise<void> {
    const current = await readWatcherState(key);
    await writeJsonFile(watcherStateFile(key), {
      schemaVersion: 1,
      key,
      ...(current?.lastDispatchedEventId === undefined
        ? {}
        : { lastDispatchedEventId: current.lastDispatchedEventId }),
      ...(current?.lastDispatchedSlot === undefined
        ? {}
        : { lastDispatchedSlot: current.lastDispatchedSlot }),
      ...(current?.failureCount === undefined ? {} : { failureCount: current.failureCount }),
      ...patch,
      updatedAt: deps.clock.now().toISOString(),
    } satisfies WatcherState);
  }

  function watcherCursorPatch(trigger: WatcherDispatch['trigger']): Partial<WatcherState> {
    return {
      ...(trigger.kind === 'event'
        ? { lastDispatchedEventId: trigger.eventId }
        : { lastDispatchedSlot: trigger.slot }),
      failureCount: 0,
    };
  }

  function isRetryEligibleWatcherFailure(input: {
    sentinel: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
    retrySafety: RetrySafety | undefined;
  }): boolean {
    return (
      input.sentinel === 'FAILED' &&
      (input.retrySafety === 'SAFE_TO_RETRY' || input.retrySafety === 'SAFE_TO_RESUME')
    );
  }

  async function updateWatcherStateAfterCompletion(input: {
    key: string | undefined;
    trigger: WatcherDispatch['trigger'] | undefined;
    sentinel: 'DONE' | 'REJECTED' | 'BLOCKED' | 'FAILED';
    retrySafety: RetrySafety | undefined;
  }): Promise<void> {
    if (input.key === undefined || input.trigger === undefined) return;

    if (isRetryEligibleWatcherFailure(input)) {
      const current = await readWatcherState(input.key);
      const failureCount = (current?.failureCount ?? 0) + 1;
      if (failureCount < deps.config.retry.maxFailureRetries) {
        await writeWatcherState(input.key, { failureCount });
        return;
      }
    }

    await writeWatcherState(input.key, watcherCursorPatch(input.trigger));
  }

  async function nextWatcherDispatch(
    projections: IssueStateRecord[],
    now: Date,
  ): Promise<WatcherDispatch | null> {
    for (const projection of projections) {
      // A closed issue can still carry a stale status label (e.g. squash-merged
      // outside Wake's own merge gate, before label reconciliation caught up),
      // so this must be checked explicitly - unlike deriveWatchlist and
      // cancellationReasonForIneligibleProjection, watcher dispatch has no
      // other path that excludes closed issues. Without this, a closed issue
      // whose last-seen local status matches `watcher.while.status` (e.g.
      // awaiting-approval) re-fires its watcher workflow every tick forever.
      if (projection.issue.state !== 'open' || !isWorkItemRunnable(projection)) continue;

      const parentWorkflow = workflowForProjection(projection, deps.config);
      if (parentWorkflow === null) continue;
      const parentWorkflowName = workflowNameForProjection(projection, deps.config);
      const stage = parentWorkflow.stages[projection.wake.stage];
      if (stage === undefined) continue;

      for (const [watcherIndex, watcher] of (stage.watch ?? []).entries()) {
        if (!watcher.while.status.includes(watcherStatus(projection))) continue;

        const key = watcherKey({
          workItemKey: projection.workItemKey,
          parentWorkflowName,
          parentStage: projection.wake.stage,
          watcherIndex,
        });
        const state = await readWatcherState(key);

        if (watcher.on !== undefined) {
          const events = await deps.stateStore.listRecentEventEnvelopes({
            workItemKey: projection.workItemKey,
            direction: 'internal',
            limit: 200,
          });
          const matchingEvents = events
            .filter((event) => watcher.on!.event.includes(event.sourceEventType))
            .filter((event) => !isEventFromWatcherRun(event))
            .sort((left, right) => left.ingestedAt.localeCompare(right.ingestedAt));
          const cursorIndex =
            state?.lastDispatchedEventId === undefined
              ? -1
              : matchingEvents.findIndex((event) => event.eventId === state.lastDispatchedEventId);
          const undispatched = matchingEvents.slice(cursorIndex + 1);
          const next = (state?.failureCount ?? 0) > 0 ? undispatched.at(0) : undispatched.at(-1);
          if (next !== undefined) {
            return {
              projection,
              parentWorkflowName,
              parentStage: projection.wake.stage,
              watcherIndex,
              targetWorkflowName: watcher.workflow,
              trigger: { kind: 'event', eventId: next.eventId },
            };
          }
        }

        if (watcher.schedule !== undefined) {
          const slot = previousMatchingSlot({
            cron: watcher.schedule.cron,
            now,
            ...(state?.lastDispatchedSlot === undefined ? {} : { after: state.lastDispatchedSlot }),
          });
          if (slot !== null) {
            return {
              projection,
              parentWorkflowName,
              parentStage: projection.wake.stage,
              watcherIndex,
              targetWorkflowName: watcher.workflow,
              trigger: { kind: 'schedule', slot },
            };
          }
        }
      }
    }

    return null;
  }

  async function resolvePrReviewTarget(input: {
    projection: IssueStateRecord;
    runId: string;
    runnerResult: AgentRunResult;
    occurredAt: string;
  }): Promise<string | null> {
    if (deps.artifactVerifier === undefined) {
      return null;
    }

    const { artifacts } = parseRunnerArtifacts(input.runnerResult.result);
    for (const artifact of artifacts) {
      const verified = await deps.artifactVerifier.verify(artifact, {
        branch: branchNameForIssue(input.projection.issue.number),
        repo: input.projection.issue.repo,
      });
      if (verified === null) {
        continue;
      }

      const incumbent = await deps.resourceIndex.resolve(verified.resourceUri);
      if (incumbent !== undefined && incumbent !== input.projection.workItemKey) {
        const conflict = createEventEnvelope({
          eventId: `${input.runId}-pr-review-primary-conflict`,
          workItemKey: input.projection.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: CORRELATION_PRIMARY_CONFLICT_EVENT,
          sourceRefs: { runId: input.runId },
          occurredAt: input.occurredAt,
          ingestedAt: input.occurredAt,
          trigger: 'context-only',
          payload: {
            resourceUri: verified.resourceUri,
            incumbentWorkItemKey: incumbent,
          },
        });
        const appended = await deps.stateStore.appendEventEnvelope(conflict);
        await projectionUpdater.rebuildFromEvents([appended]);
        return null;
      }

      if (incumbent === undefined) {
        const event = createEventEnvelope({
          eventId: `${input.runId}-pr-review-artifact-${verified.resourceUri.replace(/[^a-z0-9]+/gi, '-')}`,
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
            idempotencyKey: `${input.runId}:pr-review-artifact-registration:${verified.resourceUri}`,
          },
        });
        const appended = await deps.stateStore.appendEventEnvelope(event);
        await projectionUpdater.rebuildFromEvents([appended]);
      }

      return verified.resourceUri;
    }

    return null;
  }

  async function runRunnerTick(): Promise<TickOutcome> {
    const lock = await acquireFileLock(deps.stateStore.paths.runnerLockFile, {
      staleAfterMs: Math.min(runnerTimeoutMs(), 5 * 60 * 1000),
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

      let candidate = projections.find(
        (issue) =>
          isWorkItemRunnable(issue) &&
          policy.resolveNextEligibleAction(issue, deps.config) !== null,
      );
      const watcherDispatch =
        candidate === undefined ? await nextWatcherDispatch(projections, tickStartedAt) : null;
      candidate ??= watcherDispatch?.projection;
      let watcherStateKeyForRun: string | undefined;
      let watcherTriggerForRun: WatcherDispatch['trigger'] | undefined;
      const watcherRun = watcherDispatch !== null;

      if (candidate === undefined) {
        return { status: 'idle' as const };
      }

      if (await exceedsDispatchRateLimit(tickStartedAt)) {
        const rateLimitedWorkflowName = workflowNameForProjection(candidate, deps.config);
        const rateLimitedWorkflow = workflowForProjection(candidate, deps.config);
        const blockedAt = eventStampNow();
        await appendAuditEvent({
          eventId: `dispatch-rate-limited-${candidate.workItemKey}-${tickStartedAt.getTime()}`,
          decisionType: 'dispatch.rate-limited',
          workItemKey: candidate.workItemKey,
          runId: `dispatch-rate-limited-${candidate.workItemKey}-${tickStartedAt.getTime()}`,
          workflowRevision:
            rateLimitedWorkflow === null
              ? 'sha256:unavailable'
              : await computeWorkflowRevision({
                  config: deps.config,
                  workflowName: rateLimitedWorkflowName,
                  workflow: rateLimitedWorkflow,
                }),
          inputsConsidered: {
            windowMs: deps.config.scheduler.dispatchRateLimit.windowMs,
            maxDispatches: deps.config.scheduler.dispatchRateLimit.maxDispatches,
            watcherRun,
          },
          outcome: { dispatched: false, reason: 'dispatch-rate-limit-exceeded' },
          timestamp: blockedAt,
          sourceRefs: { repo: candidate.issue.repo, issueNumber: candidate.issue.number },
        });
        return { status: 'idle' as const };
      }

      let sourceRevision = projectedSourceRevision(candidate);
      let refresh: Awaited<ReturnType<NonNullable<WorkSource['refreshForDispatch']>>> | undefined;
      try {
        refresh = await deps.workSource.refreshForDispatch?.({ projection: candidate });
      } catch {
        return { status: 'idle' as const };
      }
      if (refresh !== undefined && refresh !== null) {
        if (refresh.sourceExists === false) {
          return { status: 'idle' as const };
        }
        sourceRevision = refresh.sourceRevision;
        if (refresh.events.length > 0) {
          await ingestInboundEvents(refresh.events);
          candidate = (await deps.stateStore.readIssueState(candidate.workItemKey)) ?? candidate;
        }
      }

      if (!watcherRun && policy.resolveNextEligibleAction(candidate, deps.config) === null) {
        return { status: 'idle' as const };
      }

      const workflow = workflowForProjection(candidate, deps.config);
      if (workflow === null) {
        return { status: 'idle' as const };
      }
      let workflowName = workflowNameForProjection(candidate, deps.config);
      let action: AgentAction;
      let command: string | undefined;
      let claimedStage = candidate.wake.stage;
      let workspaceMode: 'none' | 'read-only' | 'branch' = 'none';
      let promptContextOverrides: Record<string, unknown> | undefined;

      if (watcherDispatch !== null) {
        const targetWorkflow = deps.config.workflows[watcherDispatch.targetWorkflowName];
        if (targetWorkflow === undefined) {
          return { status: 'idle' as const };
        }
        const entryStageName = workflowEntryStage(targetWorkflow);
        const entryStage = targetWorkflow.stages[entryStageName];
        if (entryStage === undefined) {
          return { status: 'idle' as const };
        }
        action = entryStage.action ?? entryStageName;
        claimedStage = entryStageName;
        workspaceMode = entryStage.workspace;
        // The triggering event's own body (e.g. a refine plan comment) is
        // durable and already local the moment this fires — projection.comments
        // only gets it once a later GitHub poll echoes it back, which a watcher
        // dispatched off the same-tick completion event can easily outrace.
        const triggeringEvent =
          watcherDispatch.trigger.kind === 'event'
            ? await deps.stateStore.readEventEnvelope(watcherDispatch.trigger.eventId)
            : null;
        const triggeringBody = triggeringEvent?.payload.body;
        promptContextOverrides = {
          ...entryStage.promptContext,
          ...(typeof triggeringBody === 'string'
            ? { parentPendingReviewBody: triggeringBody }
            : {}),
        };
        workflowName = watcherDispatch.targetWorkflowName;
        watcherStateKeyForRun = watcherKey({
          workItemKey: watcherDispatch.projection.workItemKey,
          parentWorkflowName: watcherDispatch.parentWorkflowName,
          parentStage: watcherDispatch.parentStage,
          watcherIndex: watcherDispatch.watcherIndex,
        });
        watcherTriggerForRun = watcherDispatch.trigger;
      } else if (isAwaitingApproval(candidate)) {
        const customCommandRequest = policy.resolveCustomCommandRequest(candidate, deps.config);

        if (customCommandRequest !== null) {
          action = customCommandRequest.action;
          command = customCommandRequest.command;
          claimedStage = candidate.wake.stage;
          workspaceMode = customCommandRequest.workspace;
        } else {
          const approvalResolution = policy.resolveApprovalTransition(candidate);

          if (approvalResolution === null) {
            const changesRequestedAction = policy.resolveChangesRequestedAction(candidate);
            if (changesRequestedAction !== null) {
              action = changesRequestedAction;
              const workflowAction = chooseWorkflowAction(candidate, workflow);
              claimedStage = workflowAction?.stage ?? candidate.wake.stage;
              workspaceMode = workflowAction?.workspace ?? 'none';
              promptContextOverrides = {
                ...workflowAction?.promptContext,
                ...(typeof candidate.context.changesRequestedFeedback === 'string'
                  ? { parentPendingReviewBody: candidate.context.changesRequestedFeedback }
                  : {}),
              };
            } else {
              const reviewAction = policy.resolvePendingReviewFeedback(candidate);
              if (reviewAction === null) {
                return { status: 'idle' as const };
              }

              action = reviewAction;
              const workflowAction = chooseWorkflowAction(candidate, workflow);
              claimedStage = workflowAction?.stage ?? candidate.wake.stage;
              workspaceMode = workflowAction?.workspace ?? 'none';
              promptContextOverrides = workflowAction?.promptContext;
            }
          } else if (approvalResolution.approved) {
            const mergePolicy = approvedMergePolicyForStage(workflow.stages[candidate.wake.stage]);
            if (approvalResolution.targetResourceUri !== undefined && mergePolicy !== null) {
              const risk = await evaluatePrMergeRisk({
                projection: candidate,
                targetResourceUri: approvalResolution.targetResourceUri,
                policy: mergePolicy,
              });
              if (!risk.passed) {
                return await publishPrMergePolicyBlock({
                  projection: candidate,
                  approvalResolution,
                  reason: risk.reason,
                  workflowName,
                });
              }
              const mergeActionsResult = await performApprovedPrMergeActions({
                projection: candidate,
                approvalResolution,
                mergePolicy,
              });
              if (mergeActionsResult.blocked) {
                return await publishPrMergePolicyBlock({
                  projection: candidate,
                  approvalResolution,
                  reason: mergeActionsResult.reason,
                  workflowName,
                });
              }
            }

            const approvalId = `approval-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const approvedAt = deps.clock.now().toISOString();
            const automaticApproval = approvalResolution.automatic === true;
            const applied = await applyApprovalTransition({
              projection: candidate,
              pendingAction: approvalResolution.pendingAction,
              approvalId,
              approvedAt,
              reason: automaticApproval ? 'auto:approved' : 'human:approved',
              workflow,
              workflowName,
              payloadExtras: automaticApproval
                ? {
                    autoResolution: {
                      kind: 'awaiting-approval',
                      classification: 'auto-approval',
                      reasoning: approvalResolution.reason,
                    },
                  }
                : {
                    handledCommentId:
                      approvalResolution.triggeringCommentId ?? latestHumanCommentId(candidate),
                  },
            });
            if (applied === null) {
              return { status: 'idle' as const };
            }
            if (automaticApproval) {
              await appendAuditEvent({
                eventId: `${approvalId}-audit-auto-resolution`,
                decisionType: 'approval.auto-resolved',
                workItemKey: candidate.workItemKey,
                runId: approvalId,
                workflowRevision: await computeWorkflowRevision({
                  config: deps.config,
                  workflowName,
                  workflow,
                  action: approvalResolution.pendingAction,
                }),
                inputsConsidered: {
                  labels: candidate.issue.labels,
                  pendingAction: approvalResolution.pendingAction,
                  pendingApprovalAllowAutoApproval:
                    candidate.context.pendingApprovalAllowAutoApproval === true,
                },
                outcome: {
                  approved: true,
                  nextStage: applied.nextStage,
                  reason: approvalResolution.reason,
                },
                timestamp: approvedAt,
                sourceRefs: {
                  repo: candidate.issue.repo,
                  issueNumber: candidate.issue.number,
                },
              });
            }

            return {
              status: 'processed' as const,
              runId: approvalId,
              sentinel: 'DONE' as const,
              nextStage: applied.nextStage,
            };
          } else {
            const changesRequestId = `changes-requested-${candidate.issue.number}-${deps.clock.now().getTime()}`;
            const requestedAt = deps.clock.now().toISOString();
            const changesRequestedTriggeringCommentId =
              approvalResolution.triggeringCommentId ?? latestHumanCommentId(candidate);
            const { escalated } = await applyChangesRequestedTransition({
              projection: candidate,
              requestId: changesRequestId,
              requestedAt,
              ...(approvalResolution.triggeringCommentBody === undefined
                ? {}
                : { feedbackBody: approvalResolution.triggeringCommentBody }),
              ...(changesRequestedTriggeringCommentId === undefined
                ? {}
                : { triggeringCommentId: changesRequestedTriggeringCommentId }),
            });
            if (escalated) {
              return { status: 'idle' as const };
            }

            action = approvalResolution.pendingAction;
            const workflowAction = chooseWorkflowAction(candidate, workflow);
            claimedStage = workflowAction?.stage ?? candidate.wake.stage;
            workspaceMode = workflowAction?.workspace ?? 'none';
            promptContextOverrides = {
              ...workflowAction?.promptContext,
              ...(approvalResolution.changesRequested === true &&
              approvalResolution.triggeringCommentBody !== undefined
                ? { parentPendingReviewBody: approvalResolution.triggeringCommentBody }
                : {}),
            };
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
        promptContextOverrides = workflowAction?.promptContext;
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

      if (!(await hasSchedulerCapacity(deps.clock.now()))) {
        return { status: 'idle' as const };
      }

      const runId = `run-${candidate.issue.number}-${deps.clock.now().getTime()}`;
      const lease = createRunLease({ clock: deps.clock, ownerInstanceId });
      const workerIdentity = currentProcessIdentity();
      const runningRecord = {
        schemaVersion: 1 as const,
        runId,
        workItemKey: candidate.workItemKey,
        repo: candidate.issue.repo,
        issueNumber: candidate.issue.number,
        action,
        lifecycle: 'CREATED' as const,
        status: 'running' as const,
        startedAt: nowIso,
        routing,
        lease,
        workerPid: workerIdentity.pid,
        workerProcessStartedAt: workerIdentity.processStartedAt,
        metadata: {
          sourceRevision,
          ...(watcherRun
            ? {
                watcher: true,
                watcherWorkflow: workflowName,
                watcherTrigger: watcherTriggerForRun,
              }
            : {}),
        },
      };

      await deps.stateStore.writeRunRecord(runningRecord);
      async function transitionRunLifecycle(lifecycle: ExecutionAttemptLifecycle): Promise<void> {
        await deps.stateStore.writeRunRecord({
          ...(await deps.stateStore.readRunRecord(runId))!,
          lifecycle,
        });
      }

      async function appendRuntimeEvent(event: RuntimeEventDraft): Promise<void> {
        const timestamp = event.timestamp ?? deps.clock.now().toISOString();
        await deps.stateStore.updateRunRecordIf(runId, {
          expect: (record) =>
            record.status === 'running' &&
            record.lease?.leaseId === lease.leaseId &&
            record.lease.ownerInstanceId === ownerInstanceId,
          update: (record) => {
            const runtimeEvents = record.runtimeEvents ?? [];
            const sequence = event.sequence ?? runtimeEvents.length;
            const normalizedEvent = {
              ...event,
              timestamp,
              sequence,
            };
            return {
              ...record,
              runtimeEvents: [...runtimeEvents, normalizedEvent],
              ...(isMeaningfulRuntimeEvent(normalizedEvent)
                ? { lastMeaningfulActivityAt: normalizedEvent.timestamp }
                : {}),
            };
          },
        });
      }

      const claimedAt = eventStampNow();
      const claimedEvent = createEventEnvelope({
        eventId: `${runId}-claimed`,
        workItemKey: candidate.workItemKey,
        streamScope: 'work-item',
        direction: 'internal',
        sourceSystem: 'wake',
        sourceEventType: RUN_CLAIMED_EVENT,
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
          ...(watcherRun ? {} : { claimedStage }),
          sourceRevision,
          ...(watcherRun ? { watcherRun: true, watcherTrigger: watcherTriggerForRun } : {}),
        },
      });
      await deps.stateStore.appendEventEnvelope(claimedEvent);
      if (watcherRun && watcherDispatch !== null && watcherTriggerForRun !== undefined) {
        await appendAuditEvent({
          eventId: `${runId}-audit-watcher-dispatched`,
          decisionType: 'watcher.dispatched',
          workItemKey: candidate.workItemKey,
          runId,
          workflowRevision: await computeWorkflowRevision({
            config: deps.config,
            workflowName,
            workflow: deps.config.workflows[workflowName] ?? workflow,
            action,
          }),
          inputsConsidered: {
            parentWorkflowName: watcherDispatch.parentWorkflowName,
            parentStage: watcherDispatch.parentStage,
            watcherIndex: watcherDispatch.watcherIndex,
            watcherStatus: watcherStatus(candidate),
            trigger: watcherTriggerForRun,
          },
          outcome: {
            dispatched: true,
            targetWorkflowName: workflowName,
            action,
            claimedStage,
          },
          timestamp: claimedAt,
          sourceRefs: {
            repo: candidate.issue.repo,
            issueNumber: candidate.issue.number,
          },
        });
      }
      await transitionRunLifecycle('CLAIMED');
      await projectionUpdater.rebuildFromEvents([claimedEvent]);

      // Watcher runs execute a *different* workflow's stage (e.g. plan-review)
      // against the same parent projection, not a stage transition of the
      // parent's own workflow — writing labels here would stamp the child
      // workflow's stage/workflow onto the parent's GitHub issue. The parent's
      // labels must only ever reflect the parent's own action (see the mirrored
      // guard on the completion path below).
      if (!watcherRun) {
        await deliverOutboundEvent(
          createLabelsEvent({
            projection: candidate,
            runId,
            ...(await currentLabelsForWorkItem(candidate.workItemKey, candidate)),
            occurredAt: eventStampNow(),
          }),
        );
      }

      let leaseRenewalTimer: NodeJS.Timeout | undefined;
      function startLeaseRenewal() {
        leaseRenewalTimer = setInterval(() => {
          void renewRunLease({
            stateStore: deps.stateStore,
            runId,
            leaseId: lease.leaseId,
            ownerInstanceId,
            clock: deps.clock,
          });
        }, runLeaseRenewalIntervalMs);
      }

      function delayActiveRunRefresh(): Promise<void> {
        return new Promise((resolve) => {
          const timer = setTimeout(resolve, activeRunSourceRefreshIntervalMs);
          timer.unref?.();
        });
      }

      const recentEvents = await deps.stateStore.listEventEnvelopesForWorkItem(
        candidate.workItemKey,
        6,
      );
      const activeCandidate = candidate;
      const runnerProjection = watcherRun
        ? {
            ...activeCandidate,
            wake: {
              ...activeCandidate.wake,
              sessionId: undefined,
              sessionCli: undefined,
            },
          }
        : activeCandidate;
      const inputSnapshot = await createRunInputSnapshot({
        runId,
        createdAt: deps.clock.now().toISOString(),
        action,
        workflowName,
        workflow: deps.config.workflows[workflowName] ?? workflow,
        claimedStage,
        projection: runnerProjection,
        recentEvents,
        sourceRevision,
        routing,
        ...(watcherTriggerForRun === undefined ? {} : { watcherTrigger: watcherTriggerForRun }),
      });
      await deps.stateStore.writeRunRecord({
        ...(await deps.stateStore.readRunRecord(runId))!,
        inputSnapshotId: inputSnapshot.snapshotId,
      });

      try {
        await transitionRunLifecycle('PREPARING');
        const prepareResult: {
          workspacePath?: string;
          mergeConflictDetected?: boolean;
          upstreamChanges?: string;
          preExistingUncommittedChanges?: boolean;
          validation?: unknown;
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
        const preExistingUncommittedChanges =
          'preExistingUncommittedChanges' in prepareResult
            ? prepareResult.preExistingUncommittedChanges
            : false;

        const preparedRecord = (await deps.stateStore.readRunRecord(runId))!;
        await deps.stateStore.writeRunRecord({
          ...preparedRecord,
          lifecycle: 'PROCESS_STARTING',
          metadata: {
            ...preparedRecord.metadata,
            ...(workspacePath === undefined ? {} : { workspacePath }),
            workspaceMode,
            inputSnapshotId: inputSnapshot.snapshotId,
            ...(prepareResult.validation === undefined
              ? {}
              : { workspaceValidation: prepareResult.validation }),
          },
        });

        await transitionRunLifecycle('RUNNING');
        startLeaseRenewal();

        let executionFinished = false;
        let cancellationReason: CancellationReason | null = null;
        const runnerInput = {
          action,
          projection: runnerProjection,
          recentEvents,
          config: deps.config,
          runId,
          routing,
          workspaceMode,
          ...(promptContextOverrides === undefined ? {} : { promptContextOverrides }),
          ...(workspacePath === undefined ? {} : { workspacePath }),
          ...(mergeConflictDetected ? { mergeConflictDetected: true } : {}),
          ...(upstreamChanges === undefined ? {} : { upstreamChanges }),
          ...(preExistingUncommittedChanges ? { preExistingUncommittedChanges: true } : {}),
          onProcessStart: async (identity: { pid: number; processStartedAt: string }) => {
            await deps.stateStore.updateRunRecordIf(runId, {
              expect: (record) =>
                record.status === 'running' &&
                record.lease?.leaseId === lease.leaseId &&
                record.lease.ownerInstanceId === ownerInstanceId,
              update: (record) => ({
                ...record,
                agentPid: identity.pid,
                agentProcessStartedAt: identity.processStartedAt,
              }),
            });
          },
          onRuntimeEvent: appendRuntimeEvent,
        };
        const execution =
          deps.runner.start === undefined
            ? createAgentExecution(runnerInput, (liveInput) => deps.runner.run(liveInput))
            : await deps.runner.start(runnerInput);

        async function persistCancellationRequest(reason: CancellationReason): Promise<void> {
          const requestedAt = deps.clock.now().toISOString();
          await deps.stateStore.updateRunRecordIf(runId, {
            expect: (record) =>
              record.status === 'running' &&
              record.lease?.leaseId === lease.leaseId &&
              record.lease.ownerInstanceId === ownerInstanceId,
            update: (record) => ({
              ...record,
              metadata: {
                ...record.metadata,
                cancellation: {
                  reason,
                  requestedAt,
                  source: 'active-source-reconciliation',
                },
              },
            }),
          });
        }

        async function superviseActiveSource(): Promise<CancellationReason | null> {
          if (deps.workSource.refreshForDispatch === undefined) {
            return null;
          }

          while (!executionFinished) {
            await delayActiveRunRefresh();
            if (executionFinished) {
              return null;
            }

            let activeRefresh: SourceRefreshResult | null;
            try {
              activeRefresh = await deps.workSource.refreshForDispatch({
                projection: activeCandidate,
              });
            } catch {
              continue;
            }
            if (activeRefresh === null) {
              continue;
            }

            if (activeRefresh.events.length > 0) {
              await ingestInboundEvents(activeRefresh.events);
            }

            const refreshedProjection =
              (await deps.stateStore.readIssueState(activeCandidate.workItemKey)) ??
              activeCandidate;
            const newHumanComments = newHumanCommentsSince(
              inputSnapshot.projection,
              refreshedProjection,
            );
            if (requestsInterrupt(newHumanComments)) {
              const reason = 'CANCELED_BY_SUPERSEDING_EVENT' as const;
              cancellationReason = reason;
              await persistCancellationRequest(reason);
              await execution.cancel(reason);
              return reason;
            }

            const ineligible =
              activeRefresh.sourceExists === false ||
              !policy.isEligible(refreshedProjection, deps.config);
            if (!ineligible) {
              continue;
            }

            const reason = cancellationReasonForIneligibleProjection(
              activeRefresh.sourceExists === false ? null : refreshedProjection,
            );
            cancellationReason = reason;
            await persistCancellationRequest(reason);
            await execution.cancel(reason);
            return reason;
          }

          return null;
        }

        const runnerResult = await Promise.race([
          execution.result.finally(() => {
            executionFinished = true;
          }),
          superviseActiveSource().then(async (reason) => {
            if (reason === null) {
              return execution.result;
            }
            return execution.result;
          }),
        ]);
        clearInterval(leaseRenewalTimer);
        leaseRenewalTimer = undefined;
        const parsedRunnerResult = parseRunnerResult(runnerResult.result);
        const sentinel = parsedRunnerResult.status;
        // The approval gate is pure policy, never the agent's word choice —
        // a DONE on a stage configured with skipApproval: false is gated
        // regardless of what the agent wrote (ADR 0002).
        const skipApproval = runnerResult.metadata?.skipApproval;
        const approvalGated = sentinel === 'DONE' && skipApproval === false;
        // A canceled run must not advance the stage regardless of what the
        // runner echoed back — the snapshot it acted on was superseded.
        const nextStage =
          cancellationReason !== null
            ? null
            : approvalGated
              ? null
              : isLateralReadOnlyAction(action, deps.config) && sentinel === 'DONE'
                ? null
                : lifecycle.nextStageFromSentinel(claimedStage, sentinel, workflow);
        const finishedAt = deps.clock.now().toISOString();
        let workspaceBookkeeping: unknown;
        if (workspacePath !== undefined) {
          try {
            workspaceBookkeeping = {
              status: 'recorded',
              result: await deps.workspaceManager.recordWorkspaceBookkeeping({ workspacePath }),
            };
          } catch (error) {
            workspaceBookkeeping = {
              status: 'failed',
              failureSource: 'wake-workspace-bookkeeping',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        let prReviewTargetResourceUri: string | null = null;
        if (watcherRun) {
          // Artifact correlation is intentionally scoped to any watcher-dispatched
          // run, not to an action literally named "pr-review".
          prReviewTargetResourceUri = await resolvePrReviewTarget({
            projection: candidate,
            runId,
            runnerResult,
            occurredAt: finishedAt,
          });
          await appendAuditEvent({
            eventId: `${runId}-audit-review-verdict`,
            decisionType: 'review.verdict',
            workItemKey: candidate.workItemKey,
            runId,
            workflowRevision: await computeWorkflowRevision({
              config: deps.config,
              workflowName,
              workflow: deps.config.workflows[workflowName] ?? workflow,
              action,
            }),
            inputsConsidered: {
              sourceRevision,
              watcherTrigger: watcherTriggerForRun,
              verifiedTargetResourceUri: prReviewTargetResourceUri,
            },
            outcome: {
              sentinel,
              verdict:
                prReviewTargetResourceUri === null
                  ? 'uncertain'
                  : sentinel === 'DONE'
                    ? 'approved'
                    : sentinel === 'REJECTED'
                      ? 'changes-requested'
                      : 'uncertain',
              reasoning: parsedRunnerResult.body,
              runner: {
                model: runnerResult.model,
                cli: runnerResult.cli,
              },
            },
            timestamp: finishedAt,
            sourceRefs: {
              repo: candidate.issue.repo,
              issueNumber: candidate.issue.number,
            },
          });
        } else if (workspaceMode === 'branch') {
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
          ...(cancellationReason === null ? {} : { cancellationReason }),
          ...(runnerResult.failureClass === undefined
            ? {}
            : { failureClass: runnerResult.failureClass }),
          ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
        };

        const executionOutcome: ExecutionOutcome =
          cancellationReason !== null
            ? cancellationReason
            : runnerResult.failureClass === 'quota'
              ? 'QUOTA_EXHAUSTED'
              : runnerResult.failureClass === 'infra'
                ? 'PROCESS_FAILED'
                : 'COMPLETED';
        // Canceled runs don't produce a meaningful workflow outcome; the input
        // they acted on was superseded so the sentinel is not authoritative.
        const workflowOutcome: WorkflowOutcome | undefined =
          cancellationReason !== null
            ? undefined
            : sentinel === 'DONE'
              ? approvalGated
                ? 'AWAITING_APPROVAL'
                : 'DONE'
              : sentinel === 'REJECTED'
                ? 'CHANGES_REQUESTED'
                : sentinel === 'BLOCKED'
                  ? 'BLOCKED'
                  : undefined;

        await transitionRunLifecycle('FINALISING');
        const finalisingRecord = (await deps.stateStore.readRunRecord(runId))!;
        const failureContext =
          sentinel === 'FAILED'
            ? classifyFailedRun({
                projection: candidate,
                record: finalisingRecord,
                failureClass: runnerResult.failureClass ?? 'task',
                ...(workspacePath === undefined ? {} : { workspacePath }),
                envelope: parsedRunnerResult.envelope,
                sentinel,
              })
            : undefined;
        await deps.stateStore.writeRunRecord({
          ...finalisingRecord,
          lifecycle: 'TERMINAL',
          status:
            sentinel === 'DONE'
              ? approvalGated
                ? 'awaiting-approval'
                : 'completed'
              : sentinel === 'REJECTED'
                ? 'rejected'
                : sentinel === 'BLOCKED'
                  ? 'blocked'
                  : 'failed',
          finishedAt,
          sessionId: runnerResult.session_id,
          sentinel,
          executionOutcome,
          ...(workflowOutcome !== undefined ? { workflowOutcome } : {}),
          ...(failureContext === undefined ? {} : failureContext),
          summary: parsedRunnerResult.body,
          ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
          ...(runnerResult.tokenUsage === undefined ? {} : { tokenUsage: runnerResult.tokenUsage }),
          metadata: {
            ...finalisingRecord.metadata,
            ...(workspaceBookkeeping === undefined ? {} : { workspaceBookkeeping }),
            ...resultMetadata,
          },
        });

        // Computed before the payload so a rejecting review verdict (either
        // the PR-artifact-verified path or a plain onSuccess.approve watcher
        // with no PR) can fold context.status = 'changes-requested' on the
        // parent via the same RUN_COMPLETED event, instead of requiring a
        // separate marker comment round-trip (§5).
        const watcherSuccessPolicy =
          watcherRun && watcherDispatch !== null
            ? deps.config.workflows[watcherDispatch.parentWorkflowName]?.stages[
                watcherDispatch.parentStage
              ]?.watch?.[watcherDispatch.watcherIndex]?.onSuccess
            : undefined;
        const isReviewRejection =
          watcherRun &&
          sentinel === 'REJECTED' &&
          (prReviewTargetResourceUri !== null || watcherSuccessPolicy?.approve === true);

        const runCompletedEvent = createEventEnvelope({
          eventId: `${runId}-completed`,
          workItemKey: candidate.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: RUN_COMPLETED_EVENT,
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
            approvalGated,
            allowAutoApproval: runnerResult.metadata?.allowAutoApproval === true,
            ...(nextStage !== null ? { nextStage } : {}),
            runId,
            sessionId: runnerResult.session_id,
            sessionCli: runnerResult.cli,
            workspacePath,
            reason:
              cancellationReason === null
                ? `runner:${sentinel.toLowerCase()}`
                : `runner:${String(cancellationReason).toLowerCase()}`,
            ...(runnerResult.routing === undefined ? {} : { routing: runnerResult.routing }),
            ...(runnerResult.failureClass === undefined
              ? {}
              : { failureClass: runnerResult.failureClass }),
            ...(failureContext === undefined ? {} : failureContext),
            // Only mark the triggering comment handled when the run reached the
            // agent and produced a real outcome. Quota/infra failures are transient
            // blips; canceled runs acted on a superseded snapshot — in both cases
            // leave handledCommentId unset so the next tick can retry (S9).
            ...(runnerResult.failureClass === 'quota' ||
            runnerResult.failureClass === 'infra' ||
            cancellationReason !== null
              ? {}
              : { handledCommentId: latestActionableCommentId(inputSnapshot.projection) }),
            body: parsedRunnerResult.body,
            envelope: parsedRunnerResult.envelope,
            executionOutcome,
            ...(workflowOutcome !== undefined ? { workflowOutcome } : {}),
            ...(watcherRun ? { watcherRun: true, watcherTrigger: watcherTriggerForRun } : {}),
            ...(isReviewRejection
              ? { changesRequested: true, reviewFeedbackBody: parsedRunnerResult.body }
              : {}),
          },
        });
        await deps.stateStore.appendEventEnvelope(runCompletedEvent);
        await projectionUpdater.rebuildFromEvents([runCompletedEvent]);
        await updateWatcherStateAfterCompletion({
          key: watcherStateKeyForRun,
          trigger: watcherTriggerForRun,
          sentinel,
          retrySafety: failureContext?.retrySafety,
        });

        if (!watcherRun) {
          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              ...(await currentLabelsForWorkItem(candidate.workItemKey, candidate)),
              occurredAt: finishedAt,
            }),
          );
        }

        const publishIntent = createPublishIntentEvent({
          projection: candidate,
          runId,
          action,
          runnerResult,
          parsedRunnerResult,
          sentinel,
          approvalGated,
          occurredAt: finishedAt,
          startedAt: nowIso,
          ...(workspacePath === undefined ? {} : { workspacePath }),
          ...(typeof candidate.context.lastFailureClass === 'string'
            ? { previousFailureClass: candidate.context.lastFailureClass }
            : {}),
        });

        if (watcherRun) {
          // Watcher-dispatched runs own PR verdict delivery and correlation
          // registration regardless of the target workflow/action name.
          const pendingApprovalAction = candidate.context.pendingApprovalAction;
          if (
            prReviewTargetResourceUri !== null &&
            (sentinel === 'DONE' || sentinel === 'REJECTED')
          ) {
            await deliverOutboundEvent({
              ...publishIntent,
              sourceRefs: {
                ...publishIntent.sourceRefs,
                resourceUri: prReviewTargetResourceUri,
              },
              payload: {
                ...publishIntent.payload,
                kind: 'status-update',
                body:
                  sentinel === 'DONE'
                    ? `${parsedRunnerResult.body}\n\n${prReviewApprovalMarker}`
                    : `${parsedRunnerResult.body}\n\n<!-- wake:pr-review-changes-requested -->`,
                idempotencyKey: `${runId}:pr-review-verdict-comment`,
              },
            });
          } else if (
            watcherDispatch !== null &&
            watcherSuccessPolicy?.approve === true &&
            (sentinel === 'DONE' ||
              sentinel === 'REJECTED' ||
              sentinel === 'FAILED' ||
              sentinel === 'BLOCKED')
          ) {
            // No PR surface to carry the verdict comment: the child's sentinel
            // is its verdict. Publish the review body for every verdict so the
            // human sees why; only an ungated DONE resolves the parent's
            // pending gate (checked below via isAwaitingApproval).
            await deliverOutboundEvent(publishIntent);
            const approvalId = `${runId}-parent-approval`;
            const parentWorkflow = deps.config.workflows[watcherDispatch.parentWorkflowName];
            if (
              sentinel === 'DONE' &&
              isAwaitingApproval(candidate) &&
              typeof pendingApprovalAction === 'string' &&
              parentWorkflow !== undefined &&
              (await deps.stateStore.readEventEnvelope(`${approvalId}-completed`)) === null
            ) {
              const approvedAt = eventStampNow();
              const applied = await applyApprovalTransition({
                projection: candidate,
                pendingAction: pendingApprovalAction,
                approvalId,
                approvedAt,
                reason: 'watcher:approved',
                workflow: parentWorkflow,
                workflowName: watcherDispatch.parentWorkflowName,
              });
              if (applied !== null) {
                await appendAuditEvent({
                  eventId: `${approvalId}-audit-watcher-approval`,
                  decisionType: 'approval.watcher-resolved',
                  workItemKey: candidate.workItemKey,
                  runId,
                  workflowRevision: await computeWorkflowRevision({
                    config: deps.config,
                    workflowName: watcherDispatch.parentWorkflowName,
                    workflow: parentWorkflow,
                    action: pendingApprovalAction,
                  }),
                  inputsConsidered: {
                    watcherWorkflow: watcherDispatch.targetWorkflowName,
                    pendingAction: pendingApprovalAction,
                    childRunId: runId,
                    childSentinel: sentinel,
                  },
                  outcome: { approved: true, nextStage: applied.nextStage },
                  timestamp: approvedAt,
                  sourceRefs: {
                    repo: candidate.issue.repo,
                    issueNumber: candidate.issue.number,
                  },
                });
              }
            }
          } else {
            await suppressOutboundEvent(publishIntent, {
              suppressedPublishReason: 'pr-review-no-actionable-verdict',
            });
          }
        } else if (
          shouldPublishRunResult({
            failureClass: runnerResult.failureClass,
            previousFailureClass: candidate.context.lastFailureClass,
          })
        ) {
          await deliverOutboundEvent(publishIntent);
        } else {
          await suppressOutboundEvent(publishIntent, {
            suppressedPublishReason:
              runnerResult.failureClass === 'quota' ? 'quota-failure' : 'repeated-infra-failure',
          });
        }

        return {
          status: 'processed' as const,
          runId,
          sentinel,
          nextStage,
        };
      } catch (err) {
        clearInterval(leaseRenewalTimer);
        const finishedAt = deps.clock.now().toISOString();
        const sentinel = 'FAILED' as const;

        const failedRecord = (await deps.stateStore.readRunRecord(runId)) ?? runningRecord;
        const failedRecordMetadata = failedRecord.metadata as Record<string, unknown> | undefined;
        const failedRecordWorkspacePath =
          typeof failedRecordMetadata?.workspacePath === 'string'
            ? failedRecordMetadata.workspacePath
            : undefined;
        const failureContext = classifyFailedRun({
          projection: candidate,
          record: failedRecord,
          failureClass: 'infra',
          ...(isWorkspaceValidationFailure(err)
            ? { failurePhase: 'workspace-validation' as const }
            : {}),
          ...(failedRecordWorkspacePath === undefined
            ? {}
            : { workspacePath: failedRecordWorkspacePath }),
        });
        await deps.stateStore.writeRunRecord({
          ...failedRecord,
          lifecycle: 'TERMINAL',
          status: 'failed',
          finishedAt,
          sentinel,
          executionOutcome: 'PROCESS_FAILED' as const,
          ...failureContext,
          summary: err instanceof Error ? err.message : String(err),
          metadata: {
            ...failedRecord.metadata,
            failureClass: 'infra',
            ...(isWorkspaceValidationFailure(err)
              ? { failureSource: 'wake-workspace-validation' }
              : {}),
            ...failureContext,
          },
        });

        const runCompletedEvent = createEventEnvelope({
          eventId: `${runId}-completed`,
          workItemKey: candidate.workItemKey,
          streamScope: 'work-item',
          direction: 'internal',
          sourceSystem: 'wake',
          sourceEventType: RUN_COMPLETED_EVENT,
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
            ...failureContext,
            executionOutcome: 'PROCESS_FAILED',
            // Deliberately omit handledCommentId: an infra blip (CLI crash, timeout,
            // network error) never reached the agent, so it isn't an answer to the
            // triggering comment. Leaving it unset lets the next tick retry the same
            // request instead of silently eating it (S9).
            // Mirrors the happy-path completion payload below: without this flag,
            // projection-updater.ts folds sentinel/workflowOutcome onto the
            // *parent's* context, even though this failure belongs to a watcher's
            // own child-workflow run, not the parent's own action.
            ...(watcherRun ? { watcherRun: true, watcherTrigger: watcherTriggerForRun } : {}),
          },
        });
        await deps.stateStore.appendEventEnvelope(runCompletedEvent);
        await projectionUpdater.rebuildFromEvents([runCompletedEvent]);
        await updateWatcherStateAfterCompletion({
          key: watcherStateKeyForRun,
          trigger: watcherTriggerForRun,
          sentinel,
          retrySafety: failureContext.retrySafety,
        });

        // See the matching guard on the claim path above: a watcher run's
        // failure is not the parent's own action failing, so it must not
        // stamp the child workflow's stage/workflow onto the parent's labels.
        if (!watcherRun) {
          await deliverOutboundEvent(
            createLabelsEvent({
              projection: candidate,
              runId,
              ...(await currentLabelsForWorkItem(candidate.workItemKey, candidate)),
              occurredAt: finishedAt,
            }),
          );
        }

        const errorMessage = err instanceof Error ? err.message : String(err);
        const infraFailureResult: import('./contracts.js').AgentRunResult = {
          result: errorMessage,
          model: 'unknown',
          cli: 'unknown',
          failureClass: 'infra',
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
          ...(typeof candidate.context.lastFailureClass === 'string'
            ? { previousFailureClass: candidate.context.lastFailureClass }
            : {}),
        });
        if (
          shouldPublishRunResult({
            failureClass: 'infra',
            previousFailureClass: candidate.context.lastFailureClass,
          })
        ) {
          await deliverOutboundEvent(failurePublishIntent);
        } else {
          await suppressOutboundEvent(failurePublishIntent, {
            suppressedPublishReason: 'repeated-infra-failure',
          });
        }

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
      await deps.stateStore.assertStateHealthy();
      const intakeResult = await runIntakeTick();
      if (intakeResult.status === 'locked') {
        return intakeResult;
      }

      const runnerResult = await runRunnerTick();
      return runnerResult;
    },
  };
}
