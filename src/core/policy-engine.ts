import type { AgentAction, IssueStateRecord, Stage, WakeConfig } from '../domain/types.js';

export interface ApprovalResolution {
  approved: boolean;
  pendingAction: AgentAction;
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
      const handledIssueUpdatedAt =
        typeof context.lastHandledIssueUpdatedAt === 'string'
          ? context.lastHandledIssueUpdatedAt
          : undefined;

      if (issue.wake.lastRunId === undefined) {
        return true;
      }

      if (
        issue.latestComment !== undefined &&
        !issue.latestComment.isWakeAuthored &&
        issue.latestComment.id !== handledCommentId
      ) {
        return true;
      }

      return issue.issue.updatedAt !== handledIssueUpdatedAt;
    },
    chooseAction(stage: Stage): AgentAction | null {
      if (stage === 'queue') {
        return 'refine';
      }

      if (stage === 'refined') {
        return 'implement';
      }

      return null;
    },
    resolveApprovalTransition(issue: IssueStateRecord): ApprovalResolution | null {
      if (issue.wake.stage !== 'awaiting-approval') {
        return null;
      }

      const context = issue.context as Record<string, unknown>;
      const pendingAction: AgentAction =
        context.pendingApprovalAction === 'refine' ? 'refine' : 'implement';

      const latestHumanComment = [...issue.comments]
        .reverse()
        .find((c) => !c.isWakeAuthored && !c.isBotAuthored);

      const approved = latestHumanComment?.body.includes('/approved') ?? false;

      return { approved, pendingAction };
    },
  };
}
