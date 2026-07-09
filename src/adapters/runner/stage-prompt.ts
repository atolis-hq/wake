import type { WakeConfig } from '../../domain/types.js';
import type {
  AgentAction,
  IssueStateRecord,
} from '../../domain/types.js';
import { branchNameForIssue } from '../git/git-workspace-manager.js';
import { loadPromptTemplate, renderPromptTemplate } from './prompt-templates.js';

type CommentSnapshot = IssueStateRecord['comments'][number];

function formatComment(comment: CommentSnapshot): string {
  return `- ${comment.author.login} (${comment.createdAt}): ${comment.body}`;
}

function formatCommentList(comments: CommentSnapshot[]): string {
  return comments.length > 0 ? comments.map(formatComment).join('\n') : '(none)';
}

function newCommentsSinceLastRun(projection: IssueStateRecord): CommentSnapshot[] {
  const handledCommentId = projection.context.lastHandledCommentId;
  const cursorIndex =
    typeof handledCommentId === 'string'
      ? projection.comments.findIndex((comment) => comment.id === handledCommentId)
      : -1;
  const candidates =
    cursorIndex === -1 ? projection.comments : projection.comments.slice(cursorIndex + 1);

  return candidates.filter((comment) => !comment.isBotAuthored);
}

function parseFrontmatterList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseFrontmatterArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value.trim().split(/\s+/);
}

function parseFrontmatterMaxTurns(input: { action: AgentAction; value: string | undefined }): number {
  if (input.value === undefined || input.value.trim().length === 0) {
    throw new Error(
      `Prompt template for action "${input.action}" is missing a required "maxTurns" frontmatter value. ` +
        'Every runner invocation must carry a --max-turns cap; add one to the template.',
    );
  }

  const parsed = Number(input.value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Prompt template for action "${input.action}" has an invalid "maxTurns" frontmatter value: ${input.value}`,
    );
  }

  return parsed;
}

export interface StagePromptResult {
  prompt: string;
  permissionMode?: string;
  allowedTools: string[];
  extraArgs: string[];
  maxTurns: number;
}

function sentinelListForApproval(skipApproval: boolean): string {
  return skipApproval ? 'DONE, BLOCKED, FAILED' : 'AWAITING_APPROVAL, BLOCKED, FAILED';
}

function sentinelInstructionsForApproval(skipApproval: boolean): string {
  if (skipApproval) {
    return [
      '- DONE: the stage objective is complete.',
      '- BLOCKED: you need clarification from a human or cannot proceed safely.',
      '- FAILED: something prevented you from completing this stage at all.',
    ].join('\n');
  }

  return [
    '- AWAITING_APPROVAL: the stage objective is complete, and you have asked a human to approve before Wake proceeds. Post a comment asking the human to reply with `/approved` to confirm, or to comment with feedback if they want changes.',
    '- BLOCKED: you need clarification from a human or cannot proceed safely.',
    '- FAILED: something prevented you from completing this stage at all.',
  ].join('\n');
}

export async function buildStagePrompt(input: {
  action: AgentAction;
  projection: IssueStateRecord;
  mode?: 'start' | 'resume';
  config?: WakeConfig;
}): Promise<StagePromptResult> {
  const mode = input.mode ?? 'start';
  const template = await loadPromptTemplate(input.action, mode, {
    ...(input.config?.paths.promptsRoot === undefined
      ? {}
      : { promptsRoot: input.config.paths.promptsRoot }),
  });

  const context: Record<string, unknown> = {
    workItemKey: input.projection.workItemKey,
    repo: input.projection.issue.repo,
    issueNumber: input.projection.issue.number,
    title: input.projection.issue.title,
    stage: input.projection.wake.stage,
    body: input.projection.issue.body,
    allCommentsText: formatCommentList(input.projection.comments),
    newCommentsText: formatCommentList(newCommentsSinceLastRun(input.projection)),
  };

  if (input.action === 'implement') {
    context.branch = branchNameForIssue(input.projection.issue.number);
  }

  const allowedTools = parseFrontmatterList(template.frontmatter.allowedTools);
  context.allowedToolsList = allowedTools.length > 0 ? allowedTools.join(', ') : '(none)';

  const skipApproval = template.frontmatter.skipApproval === 'true';
  context.sentinelList = sentinelListForApproval(skipApproval);
  context.sentinelInstructions = sentinelInstructionsForApproval(skipApproval);

  const permissionMode = template.frontmatter.permissionMode;

  return {
    prompt: renderPromptTemplate(template, context),
    allowedTools,
    extraArgs: parseFrontmatterArgs(template.frontmatter.extraArgs),
    maxTurns: parseFrontmatterMaxTurns({ action: input.action, value: template.frontmatter.maxTurns }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
  };
}
