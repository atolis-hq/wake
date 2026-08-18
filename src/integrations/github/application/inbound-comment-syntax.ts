import { ReviewActorKind } from '../../../activities/index.js';
import { GitHubBuiltInCommand } from '../contracts/vocabulary.js';

export function isHumanNonWakeReply(actorKind: ReviewActorKind, body: string): boolean {
  return actorKind === ReviewActorKind.Human && !body.includes('<!-- wake:');
}

type IssueCommand =
  | typeof GitHubBuiltInCommand.Approved
  | typeof GitHubBuiltInCommand.Changes
  | typeof GitHubBuiltInCommand.Retry;

export function recognizedCommand(body: string): IssueCommand | null {
  const normalized = body.trim().toLowerCase();
  if (normalized === GitHubBuiltInCommand.Approved) return GitHubBuiltInCommand.Approved;
  if (
    normalized === GitHubBuiltInCommand.Changes ||
    normalized.startsWith(`${GitHubBuiltInCommand.Changes} `)
  )
    return GitHubBuiltInCommand.Changes;
  if (normalized === GitHubBuiltInCommand.Retry) return GitHubBuiltInCommand.Retry;
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
