import type { AgentRunResult } from './contracts.js';
import { parseRunnerResult } from '../domain/schema.js';
import type { AgentAction, EventEnvelope, IssueStateRecord } from '../domain/types.js';
import { createEventEnvelope } from '../lib/event-log.js';
import {
  extractTokenCount,
  formatCostUsd,
  formatDuration,
  formatTokenCount,
} from '../lib/format.js';

type ParsedRunnerResult = ReturnType<typeof parseRunnerResult>;

function isReviewThreadResourceUri(resourceUri: string): boolean {
  return resourceUri.split(':')[1] === 'pr-review-thread';
}

// `latestComment` is a sticky, per-work-item field: projection-updater.ts's
// comment fold overwrites it unconditionally on every inbound comment
// (any surface) and nothing ever resets it. So it means "the last comment
// this work item has ever received," not "the comment that triggered the
// currently completing run." Several needsWakeAction trigger paths (first
// run, quota-failure retry, first workflow-stage pass) complete a run
// with no fresh comment driving it at all — in those cases latestComment
// may still be pointing at an older, already-handled comment from a
// different surface (e.g. a PR) and must not be trusted as this run's
// trigger. This mirrors policy-engine.ts's needsWakeAction "is there an
// unhandled human comment" check exactly, so a comment is only treated as
// having driven this run when it's human-authored and not yet the
// candidate's own lastHandledCommentId (read from the pre-completion
// projection passed in as `candidate`/`projection`, since the completion
// event that would update lastHandledCommentId for *this* run hasn't been
// folded yet at the point this runs).
function isFreshTriggeringComment(candidate: IssueStateRecord): boolean {
  const context = candidate.context as Record<string, unknown>;
  const handledCommentId =
    typeof context.lastHandledCommentId === 'string' ? context.lastHandledCommentId : undefined;

  return (
    candidate.latestComment !== undefined &&
    !candidate.latestComment.isBotAuthored &&
    candidate.latestComment.id !== handledCommentId
  );
}

export function createPublishIntentEvent(input: {
  projection: IssueStateRecord;
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
      // Carries the triggering comment's surface (set only when the human
      // reply that woke this run came from a correlated PR/review-thread
      // resource, per the ad1cf45 comment fold) through to the sink
      // router, so createOutboundSinkRouter's kind-based routing (Task 11,
      // sink-router.ts) can send the reply back to that surface instead of
      // defaulting to the issue thread. Without this, every reply landed
      // on the origin sink regardless of which surface triggered the run.
      //
      // Gated on isFreshTriggeringComment: latestComment is sticky (see
      // that function's comment) and several run-completion paths (first
      // run, quota retry, first workflow-stage pass) have no fresh
      // comment behind them at all — for those, threading the stale
      // latestComment.resourceUri would misroute the reply to whatever
      // surface last happened to comment, even long after that comment
      // was already replied to.
      //
      // Never threads a pr-review-thread surface specifically: this is
      // Wake's own status, approval-request, or question card: a milestone
      // message, not a targeted reply to one inline comment — burying it
      // as a reply deep in a single review thread makes it easy to miss.
      // Omitting resourceUri here falls back to sourceOrigin in
      // sink-router.ts, landing it on the correlated issue (or, for a
      // standalone PR-only work item, GitHub's shared issue/PR comments
      // endpoint posts it as a top-level PR comment instead). Replies to
      // individual review threads are the agent's own job now — see
      // prompts/revise.md — via `gh api .../replies`, not this card.
      ...(input.projection.latestComment?.resourceUri === undefined ||
      !isFreshTriggeringComment(input.projection) ||
      isReviewThreadResourceUri(input.projection.latestComment.resourceUri)
        ? {}
        : { resourceUri: input.projection.latestComment.resourceUri }),
    },
    occurredAt: input.occurredAt,
    ingestedAt: input.occurredAt,
    trigger: 'context-only',
    payload: {
      kind:
        input.sentinel === 'BLOCKED'
          ? 'question'
          : input.sentinel === 'AWAITING_APPROVAL'
            ? 'approval-request'
            : input.sentinel === 'FAILED'
              ? 'failure'
              : 'status-update',
      origin: input.projection.origin ?? 'github',
      body: input.parsedRunnerResult.body,
      action: input.action,
      sentinel: input.sentinel,
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
      ...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
    },
    derivedHints: {
      stage: input.sentinel === 'DONE' ? 'done' : input.projection.wake.stage,
    },
  });
}

export function createLabelsEvent(input: {
  projection: IssueStateRecord;
  runId: string;
  statusLabel: string;
  stageLabel: string;
  workflowLabel: string;
  occurredAt: string;
}): EventEnvelope {
  return createEventEnvelope({
    eventId: `${input.runId}-labels-${input.statusLabel.replace(/[^a-z0-9]+/gi, '-')}-${input.stageLabel.replace(/[^a-z0-9]+/gi, '-')}-${input.workflowLabel.replace(/[^a-z0-9]+/gi, '-')}`,
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
      workflowLabel: input.workflowLabel,
      origin: input.projection.origin ?? 'github',
    },
  });
}
