import {
  agentActionValues,
  awaitingApprovalRunnerSentinel,
  failedRunnerSentinel,
} from '../domain/stages.js';
import type { AgentAction, IssueStateRecord, Stage, WakeConfig } from '../domain/types.js';

export interface ApprovalResolution {
  approved: boolean;
  pendingAction: AgentAction;
}

function isAwaitingApproval(issue: IssueStateRecord): boolean {
  const context = issue.context as Record<string, unknown>;
  return context.lastRunSentinel === awaitingApprovalRunnerSentinel;
}

// Commands are matched as a token at the start of a (trimmed) line, not as a
// substring anywhere in the body — so "I have *not* /approved this yet" or a
// quoted reply containing /approved does not approve the gate.
const approvedCommandPattern = /^\/approved\b/i;
const changesCommandPattern = /^\/changes\b/i;

function matchesCommand(body: string, pattern: RegExp): boolean {
  return body
    .split(/\r?\n/)
    .some((line) => pattern.test(line.trim()));
}

function latestUnhandledHumanComment(issue: IssueStateRecord): IssueStateRecord['comments'][number] | undefined {
  const context = issue.context as Record<string, unknown>;
  const handledCommentId =
    typeof context.lastHandledCommentId === 'string'
      ? context.lastHandledCommentId
      : undefined;

  // Only consider human comments that appear after the last bot comment.
  // A human /approved posted before Wake's approval-request comment must not
  // be re-consumed as approval for a later awaiting-approval cycle.
  const lastBotIndex = issue.comments.reduce(
    (acc, c, i) => (c.isBotAuthored ? i : acc),
    -1,
  );
  const humanCommentsAfterBot = issue.comments
    .slice(lastBotIndex + 1)
    .filter((c) => !c.isBotAuthored);

  const latestHumanComment = humanCommentsAfterBot.at(-1);

  if (latestHumanComment === undefined || latestHumanComment.id === handledCommentId) {
    return undefined;
  }

  return latestHumanComment;
}

export function createPolicyEngine() {
  return {
    isEligible(issue: IssueStateRecord, config: WakeConfig): boolean {
      const requiredLabels = config.sources.github.policy.requiredLabels;
      const requiredAssignees = config.sources.github.policy.requiredAssignees;

      if (requiredLabels.length === 0 && requiredAssignees.length === 0) {
        return false;
      }

      const labels = new Set(issue.issue.labels);
      const assignees = new Set(issue.issue.assignees);

      if (issue.issue.state !== 'open') {
        return false;
      }

      if (issue.issue.isPullRequest) {
        return false;
      }

      if (requiredLabels.some((label) => !labels.has(label))) {
        return false;
      }

      if (
        config.sources.github.policy.ignoredLabels.some((label) => labels.has(label))
      ) {
        return false;
      }

      if (
        requiredAssignees.length > 0 &&
        !requiredAssignees.some((login) => assignees.has(login))
      ) {
        return false;
      }

      return true;
    },
    needsWakeAction(issue: IssueStateRecord): boolean {
      const context = issue.context as Record<string, unknown>;
      const handledCommentId =
        typeof context.lastHandledCommentId === 'string'
          ? context.lastHandledCommentId
          : undefined;
      const lastCompletedAction =
        typeof context.lastCompletedAction === 'string'
          ? context.lastCompletedAction
          : undefined;
      const lastRunSentinel =
        typeof context.lastRunSentinel === 'string'
          ? context.lastRunSentinel
          : undefined;
      const lastFailureClass =
        typeof context.lastFailureClass === 'string'
          ? context.lastFailureClass
          : undefined;

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

      if (lastRunSentinel === failedRunnerSentinel && lastFailureClass !== 'quota') {
        return false;
      }

      if (lastFailureClass === 'quota') {
        return true;
      }

      if (issue.wake.stage === 'queue' && lastCompletedAction !== 'refine') {
        return true;
      }

      if (issue.wake.stage === 'implement' && lastCompletedAction !== 'implement') {
        return true;
      }

      return false;
    },
    chooseAction(stage: Stage): AgentAction | null {
      if (stage === 'queue') {
        return 'refine';
      }

      if (stage === 'implement') {
        return 'implement';
      }

      return null;
    },
    chooseRetryActionAfterHumanReply(issue: IssueStateRecord): AgentAction | null {
      const context = issue.context as Record<string, unknown>;
      const failed = context.lastRunSentinel === failedRunnerSentinel;
      const blocked = context.lastRunSentinel === 'BLOCKED';
      if (failed && context.lastFailureClass === 'quota') {
        return agentActionValues.includes(context.lastRunAction as AgentAction)
          ? (context.lastRunAction as AgentAction)
          : null;
      }

      if (!blocked && !failed) {
        return null;
      }

      if (latestUnhandledHumanComment(issue) === undefined) {
        return null;
      }

      return agentActionValues.includes(context.lastRunAction as AgentAction)
        ? (context.lastRunAction as AgentAction)
        : null;
    },
    resolveApprovalTransition(issue: IssueStateRecord): ApprovalResolution | null {
      if (!isAwaitingApproval(issue)) {
        return null;
      }

      const context = issue.context as Record<string, unknown>;
      const pendingAction: AgentAction = agentActionValues.includes(
        context.pendingApprovalAction as AgentAction,
      )
        ? (context.pendingApprovalAction as AgentAction)
        : 'implement';

      // No new human comment since the last handled one; stay idle instead of
      // falling through to the LLM while awaiting explicit approval feedback.
      const latestHumanComment = latestUnhandledHumanComment(issue);
      if (latestHumanComment === undefined) {
        return null;
      }

      const approved = matchesCommand(latestHumanComment.body, approvedCommandPattern);
      const changesRequested = matchesCommand(latestHumanComment.body, changesCommandPattern);

      // Neither an explicit /approved nor an explicit /changes: treat this as
      // conversation, not a decision. Stay idle rather than re-running the
      // pending action off the back of a clarifying question (S2). The comment
      // stays unhandled, so it's reconsidered on the next tick and by a human
      // who follows up with an explicit command.
      if (!approved && !changesRequested) {
        return null;
      }

      return { approved, pendingAction };
    },
  };
}
