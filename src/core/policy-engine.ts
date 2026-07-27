import { awaitingApprovalRunnerSentinel, failedRunnerSentinel } from '../domain/stages.js';
import { resolveCustomCommand } from '../domain/custom-commands.js';
import type { CustomCommandResolution } from '../domain/custom-commands.js';
import {
  builtInDefaultWorkflowDefinition,
  chooseAction as chooseWorkflowAction,
  isKnownWorkflowStage,
  selectWorkflowForEvent,
  workflowForProjection,
} from '../domain/workflows.js';
import type {
  AgentAction,
  IssueStateRecord,
  WakeConfig,
  WorkflowDefinition,
} from '../domain/types.js';
import { alwaysManualIgnoredLabels } from '../domain/manual-labels.js';
import { autoApprovalLabel } from './approval-intents.js';
import type { UnkeyedEventEnvelope } from './contracts.js';

export interface ApprovalResolution {
  approved: boolean;
  pendingAction: AgentAction;
  automatic?: boolean;
  reason?: string;
  targetResourceUri?: string;
  triggeringCommentId?: string;
  triggeringCommentBody?: string;
}

function isAwaitingApproval(issue: IssueStateRecord): boolean {
  const context = issue.context as Record<string, unknown>;
  return context.lastRunSentinel === awaitingApprovalRunnerSentinel;
}

function belowFailureRetryLimit(issue: IssueStateRecord, config?: WakeConfig): boolean {
  if (config === undefined) {
    return true;
  }

  const context = issue.context as Record<string, unknown>;
  const failureCount =
    typeof context.failureCount === 'number' && Number.isInteger(context.failureCount)
      ? context.failureCount
      : 0;
  return failureCount < config.retry.maxFailureRetries;
}

// Commands are matched as a token at the start of a (trimmed) line, not as a
// substring anywhere in the body — so "I have *not* /approved this yet" or a
// quoted reply containing /approved does not approve the gate.
const approvedCommandPattern = /^\/approved\b/i;
const changesCommandPattern = /^\/changes\b/i;
const prReviewApprovalMarker = '<!-- wake:pr-review-approved -->';
const prReviewChangesMarker = '<!-- wake:pr-review-changes-requested -->';

// The action Wake runs when a correlated PR gets new reviewer feedback while
// the work item is awaiting approval. Not configurable per workflow: it's a
// lateral response to a PR surface, not a workflow stage.
const reviewFeedbackAction = 'revise';

function matchesCommand(body: string, pattern: RegExp): boolean {
  return body.split(/\r?\n/).some((line) => pattern.test(line.trim()));
}

function labelsAndAssigneesQualify(input: {
  labels: string[];
  assignees: string[];
  requiredLabels: string[];
  ignoredLabels: string[];
  requiredAssignees: string[];
}): boolean {
  if (input.requiredLabels.length === 0 && input.requiredAssignees.length === 0) {
    return false;
  }

  const labels = new Set(input.labels);
  const assignees = new Set(input.assignees);

  if (input.requiredLabels.some((label) => !labels.has(label))) {
    return false;
  }

  const ignoredLabels = new Set([...input.ignoredLabels, ...alwaysManualIgnoredLabels]);
  if ([...ignoredLabels].some((label) => labels.has(label))) {
    return false;
  }

  if (
    input.requiredAssignees.length > 0 &&
    !input.requiredAssignees.some((login) => assignees.has(login))
  ) {
    return false;
  }

  return true;
}

function latestUnhandledHumanComment(
  issue: IssueStateRecord,
): IssueStateRecord['comments'][number] | undefined {
  const context = issue.context as Record<string, unknown>;
  const handledCommentId =
    typeof context.lastHandledCommentId === 'string' ? context.lastHandledCommentId : undefined;

  // Only consider human comments that appear after the last bot comment.
  // A human /approved posted before Wake's approval-request comment must not
  // be re-consumed as approval for a later awaiting-approval cycle.
  const lastBotIndex = issue.comments.reduce((acc, c, i) => (c.isBotAuthored ? i : acc), -1);
  const humanCommentsAfterBot = issue.comments
    .slice(lastBotIndex + 1)
    .filter((c) => !c.isBotAuthored);

  const latestHumanComment = humanCommentsAfterBot.at(-1);

  if (latestHumanComment === undefined || latestHumanComment.id === handledCommentId) {
    return undefined;
  }

  return latestHumanComment;
}

function latestUnhandledComment(
  issue: IssueStateRecord,
): IssueStateRecord['comments'][number] | undefined {
  const context = issue.context as Record<string, unknown>;
  const handledCommentId =
    typeof context.lastHandledCommentId === 'string' ? context.lastHandledCommentId : undefined;
  const lastBotIndex = issue.comments.reduce((acc, c, i) => (c.isBotAuthored ? i : acc), -1);
  const latest = issue.comments.slice(lastBotIndex).at(-1);
  if (latest === undefined || latest.id === handledCommentId) {
    return undefined;
  }
  return latest;
}

export function createPolicyEngine() {
  return {
    isEligible(issue: IssueStateRecord, config: WakeConfig): boolean {
      if (issue.issue.state !== 'open') {
        return false;
      }

      if (issue.issue.labels.some((label) => alwaysManualIgnoredLabels.includes(label))) {
        return false;
      }

      // Defense-in-depth: the issues source filters PR-shaped items at poll
      // time, so no NEW projection can ever have isPullRequest: true. But a
      // pre-existing state/<workId>.json written by a pre-this-branch
      // version of Wake could still hold isPullRequest: true, since the old
      // fold created projections regardless of eligibility.
      if (issue.issue.isPullRequest) {
        return false;
      }

      // Source policy is always checked first — workflow selectors are optional secondary filter.
      if (
        !labelsAndAssigneesQualify({
          labels: issue.issue.labels,
          assignees: issue.issue.assignees,
          requiredLabels: config.sources.github.policy.requiredLabels,
          ignoredLabels: config.sources.github.policy.ignoredLabels,
          requiredAssignees: config.sources.github.policy.requiredAssignees,
        })
      ) {
        return false;
      }

      // If workflow selectors are configured as the routing mechanism, the issue must have
      // a workflow assigned (set by a matching selector when the issue was first minted).
      if (config.workflowSelectors.length > 0) {
        const context = issue.context as Record<string, unknown>;
        return typeof context.workflow === 'string';
      }

      return true;
    },
    needsWakeAction(
      issue: IssueStateRecord,
      workflow: WorkflowDefinition = builtInDefaultWorkflowDefinition,
      config?: WakeConfig,
    ): boolean {
      const context = issue.context as Record<string, unknown>;
      const handledCommentId =
        typeof context.lastHandledCommentId === 'string' ? context.lastHandledCommentId : undefined;
      const lastCompletedAction =
        typeof context.lastCompletedAction === 'string' ? context.lastCompletedAction : undefined;
      const lastRunSentinel =
        typeof context.lastRunSentinel === 'string' ? context.lastRunSentinel : undefined;
      const lastRetrySafety =
        typeof context.lastRetrySafety === 'string' ? context.lastRetrySafety : undefined;

      if (issue.wake.lastRunId === undefined) {
        return true;
      }

      if (
        issue.latestComment !== undefined &&
        !issue.latestComment.isBotAuthored &&
        issue.latestComment.id !== handledCommentId
      ) {
        return true;
      }

      if (isAwaitingApproval(issue)) {
        return false;
      }

      if (lastRunSentinel === failedRunnerSentinel) {
        if (lastRetrySafety === 'SAFE_TO_RETRY' || lastRetrySafety === 'SAFE_TO_RESUME') {
          return belowFailureRetryLimit(issue, config);
        }
        return false;
      }

      if (lastRunSentinel === 'BLOCKED') {
        return false;
      }

      const workflowAction = chooseWorkflowAction(issue, workflow);
      return workflowAction !== null && lastCompletedAction !== workflowAction.action;
    },
    chooseAction(
      issue: IssueStateRecord,
      workflow: WorkflowDefinition = builtInDefaultWorkflowDefinition,
    ): AgentAction | null {
      return chooseWorkflowAction(issue, workflow)?.action ?? null;
    },
    chooseRetryActionAfterHumanReply(
      issue: IssueStateRecord,
      workflow: WorkflowDefinition = builtInDefaultWorkflowDefinition,
    ): AgentAction | null {
      const context = issue.context as Record<string, unknown>;
      const failed = context.lastRunSentinel === failedRunnerSentinel;
      const blocked = context.lastRunSentinel === 'BLOCKED';
      if (failed && context.lastFailureClass === 'quota') {
        return typeof context.lastRunAction === 'string' ? context.lastRunAction : null;
      }

      if (!blocked && !failed) {
        return null;
      }

      if (latestUnhandledHumanComment(issue) === undefined) {
        return null;
      }

      if (typeof context.blockedFromStage !== 'string') {
        return null;
      }

      return (
        chooseWorkflowAction(
          {
            ...issue,
            wake: {
              ...issue.wake,
              stage: context.blockedFromStage,
            },
          },
          workflow,
        )?.action ?? null
      );
    },
    resolveApprovalTransition(issue: IssueStateRecord): ApprovalResolution | null {
      if (!isAwaitingApproval(issue)) {
        return null;
      }

      const context = issue.context as Record<string, unknown>;
      const pendingAction: AgentAction | undefined =
        typeof context.pendingApprovalAction === 'string'
          ? context.pendingApprovalAction
          : undefined;

      // No new human comment since the last handled one; stay idle instead of
      // falling through to the LLM while awaiting explicit approval feedback.
      const latestHumanComment = latestUnhandledHumanComment(issue);
      const latestComment = latestUnhandledComment(issue);
      if (pendingAction === undefined) {
        return null;
      }

      if (
        context.pendingApprovalAllowAutoApproval === true &&
        issue.issue.labels.includes(autoApprovalLabel)
      ) {
        return {
          approved: true,
          pendingAction,
          automatic: true,
          reason:
            'Issue has wake:auto and the pending action prompt declared allowAutoApproval: true.',
        };
      }

      if (
        latestComment?.isBotAuthored === true &&
        latestComment.resourceUri !== undefined &&
        latestComment.body.includes(prReviewApprovalMarker)
      ) {
        return {
          approved: true,
          pendingAction,
          targetResourceUri: latestComment.resourceUri,
          triggeringCommentId: latestComment.id,
          triggeringCommentBody: latestComment.body,
        };
      }
      if (latestHumanComment === undefined) {
        return null;
      }

      const approved = matchesCommand(latestHumanComment.body, approvedCommandPattern);
      const changesRequested = matchesCommand(latestHumanComment.body, changesCommandPattern);

      // Neither an explicit /approved nor /changes: treat this as
      // conversation, not a decision. Stay idle rather than re-running the
      // pending action off the back of an unmarked clarifying question (S2).
      // The comment stays unhandled, so it's reconsidered on the next tick and
      // by a human who follows up with an explicit command.
      if (!approved && !changesRequested) {
        return null;
      }

      return { approved, pendingAction };
    },
    // Callers must try resolveApprovalTransition first and only fall back to
    // this when it returns null. resolveApprovalTransition doesn't check
    // resourceUri, so a PR-surface comment that happens to carry an explicit
    // /approved or /changes command is deliberately still routed
    // there — this function only ever sees comments resolveApprovalTransition
    // already passed on (plain PR feedback with no command).
    resolvePendingReviewFeedback(issue: IssueStateRecord): AgentAction | null {
      if (!isAwaitingApproval(issue)) {
        return null;
      }

      const latestHumanComment = latestUnhandledHumanComment(issue);
      const latestComment = latestUnhandledComment(issue);

      if (
        latestComment?.isBotAuthored === true &&
        latestComment.resourceUri !== undefined &&
        latestComment.body.includes(prReviewChangesMarker)
      ) {
        return reviewFeedbackAction;
      }

      // resourceUri is set only on comments folded from a correlated PR/review
      // surface (schema.ts's commentSnapshotSchema: "absent = the originating
      // issue thread"). A comment on that surface is itself the deliberate
      // act — unlike an issue-thread reply, it doesn't need an explicit
      // /approved-style command to count as a decision.
      if (latestHumanComment === undefined || latestHumanComment.resourceUri === undefined) {
        return null;
      }

      return reviewFeedbackAction;
    },
    resolveCustomCommandRequest(
      issue: IssueStateRecord,
      config: WakeConfig,
    ): CustomCommandResolution | null {
      return resolveCustomCommand(issue, config);
    },
    // The single eligibility predicate: is this issue open, on a known workflow
    // stage, and does it have a next action Wake should run? Returns the
    // resolved action plus the workflow it belongs to, or null when there is
    // nothing to do. This used to be duplicated as two independently-drifting
    // copies (the pending-label marker and the runner's candidate `find`), which
    // is exactly the class of "a rule change didn't propagate everywhere" that
    // caused the #258 incident — keep it as the one source of truth.
    resolveNextEligibleAction(
      issue: IssueStateRecord,
      config: WakeConfig,
    ): { action: AgentAction; workflow: WorkflowDefinition } | null {
      if (!this.isEligible(issue, config)) {
        return null;
      }
      const workflow = workflowForProjection(issue, config);
      if (workflow === null || !isKnownWorkflowStage(issue.wake.stage, workflow)) {
        return null;
      }

      if (isAwaitingApproval(issue)) {
        const customCommand = resolveCustomCommand(issue, config);
        if (customCommand !== null) {
          return { action: customCommand.action, workflow };
        }
        const approval = this.resolveApprovalTransition(issue);
        if (approval !== null) {
          return { action: approval.pendingAction, workflow };
        }
        const reviewAction = this.resolvePendingReviewFeedback(issue);
        if (reviewAction !== null) {
          return { action: reviewAction, workflow };
        }
        return null;
      }

      const nextAction =
        resolveCustomCommand(issue, config)?.action ??
        this.chooseAction(issue, workflow) ??
        this.chooseRetryActionAfterHumanReply(issue, workflow);
      if (nextAction === null || !this.needsWakeAction(issue, workflow, config)) {
        return null;
      }

      return { action: nextAction, workflow };
    },
    qualifiesForMint(unresolved: UnkeyedEventEnvelope, config: WakeConfig): boolean {
      const resourceUri = unresolved.sourceRefs.resourceUri;
      if (resourceUri === undefined) {
        return false;
      }

      const kind = resourceUri.split(':')[1];
      if (kind === 'schedule') {
        const workflow = unresolved.payload.workflow;
        return typeof workflow === 'string' && config.workflows[workflow] !== undefined;
      }

      // Source policy enforcement is always checked first — workflow selectors are optional secondary routing.
      if (kind === 'issue') {
        // Real github source stamps payload.ticket (sourceEventType
        // 'ticket.upsert'); the fake ticketing harness stamps payload.issue
        // (sourceEventType 'fake.issue.upsert') — the same dual-key
        // recognition projection-updater.ts's createProjectionFromIssueEvent
        // already applies when folding these into a projection. Qualification
        // must accept both or the fake never qualifies anything, which would
        // silently defeat every fixture that exercises minting through it.
        const ticket = (unresolved.payload.ticket ?? unresolved.payload.issue) as
          { labels?: unknown; assignees?: unknown } | undefined;
        if (ticket === undefined) {
          return false;
        }
        if (
          !labelsAndAssigneesQualify({
            labels: Array.isArray(ticket.labels) ? ticket.labels : [],
            assignees: Array.isArray(ticket.assignees) ? ticket.assignees : [],
            requiredLabels: config.sources.github.policy.requiredLabels,
            ignoredLabels: config.sources.github.policy.ignoredLabels,
            requiredAssignees: config.sources.github.policy.requiredAssignees,
          })
        ) {
          return false;
        }
        // Issue passed source policy; if workflow selectors are configured, also check routing.
        if (config.workflowSelectors.length > 0) {
          return selectWorkflowForEvent(unresolved, config) !== null;
        }
        return true;
      }

      if (kind === 'pr') {
        if (!config.sources.github.pullRequests.enabled) {
          return false;
        }
        const pr = unresolved.payload.pr as { author?: unknown } | undefined;
        const requiredAuthors = config.sources.github.pullRequests.policy.requiredAuthors;
        // If requiredAuthors is empty, source policy allows any author.
        if (requiredAuthors.length > 0) {
          if (typeof pr?.author !== 'string' || !requiredAuthors.includes(pr.author)) {
            return false;
          }
        }
        // PR passed source policy; if workflow selectors are configured, also check routing.
        if (config.workflowSelectors.length > 0) {
          return selectWorkflowForEvent(unresolved, config) !== null;
        }
        return true;
      }

      return false;
    },
  };
}
