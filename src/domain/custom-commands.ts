import type { AgentAction, IssueStateRecord, WakeConfig } from './types.js';

type CommentSnapshot = IssueStateRecord['comments'][number];

export interface CustomCommandResolution {
  action: AgentAction;
  command: string;
  comment: CommentSnapshot;
  workspace: 'none' | 'read-only' | 'branch';
}

export const reservedCommandNames = ['approved', 'changes', 'question'];

function latestUnhandledHumanComment(
  issue: IssueStateRecord,
): IssueStateRecord['comments'][number] | undefined {
  const context = issue.context as Record<string, unknown>;
  const handledCommentId =
    typeof context.lastHandledCommentId === 'string' ? context.lastHandledCommentId : undefined;

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

function commandNameFromBody(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = /^\/([A-Za-z0-9_.-]+)\b/.exec(line.trim());
    if (match?.[1] !== undefined) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

export function customCommandAction(command: string, config: WakeConfig): AgentAction | undefined {
  const entry = Object.entries(config.commands).find(
    ([name]) => name.toLowerCase() === command.toLowerCase(),
  );
  if (entry === undefined) {
    return undefined;
  }

  const [name, definition] = entry;
  return definition.action ?? name;
}

export function isCustomCommandAction(action: AgentAction, config: WakeConfig): boolean {
  return Object.entries(config.commands).some(
    ([name, definition]) => (definition.action ?? name) === action,
  );
}

export function customCommandWorkspace(
  action: AgentAction,
  config: WakeConfig,
): 'none' | 'read-only' | 'branch' | undefined {
  return Object.entries(config.commands).find(
    ([name, definition]) => (definition.action ?? name) === action,
  )?.[1].workspace;
}

export function resolveCustomCommand(
  issue: IssueStateRecord,
  config: WakeConfig,
): CustomCommandResolution | null {
  const latestHumanComment = latestUnhandledHumanComment(issue);
  if (latestHumanComment === undefined) {
    return null;
  }

  const command = commandNameFromBody(latestHumanComment.body);
  if (command === null) {
    return null;
  }

  const definitionEntry = Object.entries(config.commands).find(
    ([name]) => name.toLowerCase() === command,
  );
  if (definitionEntry === undefined) {
    return null;
  }

  const [configuredName, definition] = definitionEntry;
  return {
    action: definition.action ?? configuredName,
    command: configuredName,
    comment: latestHumanComment,
    workspace: definition.workspace,
  };
}
