import {
  agentActionValues,
  awaitingApprovalRunnerSentinel,
  failedRunnerSentinel,
} from '../domain/stages.js';
import type { AgentAction, IssueStateRecord, Stage, WakeConfig } from '../domain/types.js';
import type { UnkeyedEventEnvelope } from './contracts.js';

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
const questionCommandPattern = /^\/question\b/i;

function matchesCommand(body: string, pattern: RegExp): boolean {
  return body
    .split(/\r?\n/)
    .some((line) => pattern.test(line.trim()));
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

  if (input.ignoredLabels.some((label) => labels.has(label))) {
    return false;
  }

  if (input.requiredAssignees.length > 0 && !input.requiredAssignees.some((login) => assignees.has(login))) {
    return false;
  }

  return true;
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
      if (issue.issue.state !== 'open') {
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

      return labelsAndAssigneesQualify({
        labels: issue.issue.labels,
        assignees: issue.issue.assignees,
        requiredLabels: config.sources.github.policy.requiredLabels,
        ignoredLabels: config.sources.github.policy.ignoredLabels,
        requiredAssignees: config.sources.github.policy.requiredAssignees,
      });
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
      const questionAsked = matchesCommand(latestHumanComment.body, questionCommandPattern);

      // Neither an explicit /approved, /changes, nor /question: treat this as
      // conversation, not a decision. Stay idle rather than re-running the
      // pending action off the back of an unmarked clarifying question (S2).
      // The comment stays unhandled, so it's reconsidered on the next tick and
      // by a human who follows up with an explicit command.
      if (!approved && !changesRequested && !questionAsked) {
        return null;
      }

      return { approved, pendingAction };
    },
    qualifiesForMint(unresolved: UnkeyedEventEnvelope, config: WakeConfig): boolean {
      const resourceUri = unresolved.sourceRefs.resourceUri;
      if (resourceUri === undefined) {
        return false;
      }

      const kind = resourceUri.split(':')[1];

      if (kind === 'issue') {
        // Real github source stamps payload.ticket (sourceEventType
        // 'ticket.upsert'); the fake ticketing harness stamps payload.issue
        // (sourceEventType 'fake.issue.upsert') — the same dual-key
        // recognition projection-updater.ts's createProjectionFromIssueEvent
        // already applies when folding these into a projection. Qualification
        // must accept both or the fake never qualifies anything, which would
        // silently defeat every fixture that exercises minting through it.
        const ticket = (unresolved.payload.ticket ?? unresolved.payload.issue) as
          | { labels?: unknown; assignees?: unknown }
          | undefined;
        if (ticket === undefined) {
          return false;
        }
        return labelsAndAssigneesQualify({
          labels: Array.isArray(ticket.labels) ? ticket.labels : [],
          assignees: Array.isArray(ticket.assignees) ? ticket.assignees : [],
          requiredLabels: config.sources.github.policy.requiredLabels,
          ignoredLabels: config.sources.github.policy.ignoredLabels,
          requiredAssignees: config.sources.github.policy.requiredAssignees,
        });
      }

      if (kind === 'pr') {
        const pr = unresolved.payload.pr as { author?: unknown } | undefined;
        const requiredAuthors = config.sources.github.pullRequests.policy.requiredAuthors;
        if (requiredAuthors.length === 0 || typeof pr?.author !== 'string') {
          return false;
        }
        return requiredAuthors.includes(pr.author);
      }

      return false;
    },
  };
}
