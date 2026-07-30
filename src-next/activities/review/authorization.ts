import type { ReviewerAuthorizationEvidence } from './contracts.js';

export function isReviewAuthorized(input: {
  readonly actorId: string;
  readonly actorKind: 'human' | 'bot';
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
}): boolean {
  if (input.actorKind !== 'human') return false;
  if (sameIdentity(input.actorId, input.resourceAuthorId)) return false;
  if (input.authorization.source === 'configured-reviewer')
    return sameIdentity(input.actorId, input.authorization.reviewerId);
  if (input.authorization.source !== 'provider-permission') return false;
  return trustedPermissions.has(input.authorization.permission);
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const trustedPermissions = new Set(['write', 'maintain', 'admin']);
