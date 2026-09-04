import { ReviewActorKind } from '../../../activities/index.js';
import { GitHubBuiltInCommand } from '../contracts/vocabulary.js';

export function isHumanNonWakeReply(actorKind: ReviewActorKind, body: string): boolean {
  return actorKind === ReviewActorKind.Human && !body.includes('<!-- wake:');
}

type IssueCommand =
  | typeof GitHubBuiltInCommand.Approved
  | typeof GitHubBuiltInCommand.Accepted
  | typeof GitHubBuiltInCommand.Changes
  | typeof GitHubBuiltInCommand.Retry
  | typeof GitHubBuiltInCommand.Restart
  | typeof GitHubBuiltInCommand.Extend;

function commandLine(body: string): string {
  const trimmed = body.trim();
  const newlineIndex = trimmed.indexOf('\n');
  const line = newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex);
  return line.trim().toLowerCase();
}

function matchesCommand(line: string, command: string): boolean {
  return line === command || (line.startsWith(command) && /\s/.test(line.charAt(command.length)));
}

export function recognizedCommand(body: string): IssueCommand | null {
  const line = commandLine(body);
  if (matchesCommand(line, GitHubBuiltInCommand.Approved)) return GitHubBuiltInCommand.Approved;
  if (matchesCommand(line, GitHubBuiltInCommand.Accepted)) return GitHubBuiltInCommand.Accepted;
  if (matchesCommand(line, GitHubBuiltInCommand.Changes)) return GitHubBuiltInCommand.Changes;
  if (matchesCommand(line, GitHubBuiltInCommand.Retry)) return GitHubBuiltInCommand.Retry;
  if (matchesCommand(line, GitHubBuiltInCommand.Restart)) return GitHubBuiltInCommand.Restart;
  if (matchesCommand(line, GitHubBuiltInCommand.Extend)) return GitHubBuiltInCommand.Extend;
  return null;
}

export function isPlainReply(body: string): boolean {
  const normalized = body.trim();
  return normalized.length > 0 && !normalized.startsWith('/');
}

export function shouldResumeBlockedStage(
  command: IssueCommand | null,
  plainReply: boolean,
): boolean {
  return command === GitHubBuiltInCommand.Changes || plainReply;
}
