import { agentActionValues, failedRunnerSentinel } from '../domain/stages.js';
import type { AgentAction, IssueStateRecord, Stage, WakeConfig } from '../domain/types.js';

export interface ApprovalResolution {
  approved: boolean;
  pendingAction: AgentAction;
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

      if (lastRunSentinel === failedRunnerSentinel) {
        return false;
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
      if (issue.wake.stage !== 'blocked' && issue.wake.stage !== 'failed') {
        return null;
      }

      if (latestUnhandledHumanComment(issue) === undefined) {
        return null;
      }

      const context = issue.context as Record<string, unknown>;
      return agentActionValues.includes(context.lastRunAction as AgentAction)
        ? (context.lastRunAction as AgentAction)
        : null;
    },
    resolveApprovalTransition(issue: IssueStateRecord): ApprovalResolution | null {
      if (issue.wake.stage !== 'awaiting-approval') {
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

      const approved = latestHumanComment.body.includes('/approved');

      return { approved, pendingAction };
    },
  };
}
