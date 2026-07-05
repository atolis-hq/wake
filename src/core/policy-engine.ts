import type { AgentAction, IssueStateRecord, Stage, WakeConfig } from '../domain/types.js';

export function createPolicyEngine() {
  return {
    isEligible(issue: IssueStateRecord, config: WakeConfig): boolean {
      const labels = new Set(issue.issue.labels);

      if (issue.issue.state !== 'open') {
        return false;
      }

      if (
        config.sources.github.policy.requiredLabels.some((label) => !labels.has(label))
      ) {
        return false;
      }

      if (
        config.sources.github.policy.ignoredLabels.some((label) => labels.has(label))
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
  };
}
