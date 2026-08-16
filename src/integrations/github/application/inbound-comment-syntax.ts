import { ReviewActorKind } from '../../../activities/index.js';

export function isHumanNonWakeReply(actorKind: ReviewActorKind, body: string): boolean {
  return actorKind === ReviewActorKind.Human && !body.includes('<!-- wake:');
}

export function recognizedCommand(body: string): '/approved' | '/changes' | '/retry' | null {
  const normalized = body.trim().toLowerCase();
  if (normalized === '/approved') return '/approved';
  if (normalized === '/changes' || normalized.startsWith('/changes ')) return '/changes';
  if (normalized === '/retry') return '/retry';
  return null;
}

export function isPlainReply(body: string): boolean {
  const normalized = body.trim();
  return normalized.length > 0 && !normalized.startsWith('/');
}

export function shouldResumeBlockedStage(
  command: '/approved' | '/changes' | '/retry' | null,
  plainReply: boolean,
): boolean {
  return command === '/changes' || plainReply;
}
