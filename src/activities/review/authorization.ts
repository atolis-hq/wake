import type {
  ProviderPermission as ProviderPermissionValue,
  ReviewerAuthorizationEvidence,
} from './contracts.js';
import { ProviderPermission, ReviewActorKind, ReviewerAuthorizationSource } from './contracts.js';

export function isReviewAuthorized(input: {
  readonly actorId: string;
  readonly actorKind: typeof ReviewActorKind.Human | typeof ReviewActorKind.Bot;
  readonly origin?: 'provider-native-review';
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
}): boolean {
  if (input.origin === 'provider-native-review') return true;
  if (input.actorKind !== ReviewActorKind.Human) return false;
  if (sameIdentity(input.actorId, input.resourceAuthorId)) return false;
  if (input.authorization.source === ReviewerAuthorizationSource.ConfiguredReviewer)
    return sameIdentity(input.actorId, input.authorization.reviewerId);
  if (input.authorization.source !== ReviewerAuthorizationSource.ProviderPermission) return false;
  return trustedPermissions.has(input.authorization.permission);
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

const trustedPermissions = new Set<ProviderPermissionValue>([
  ProviderPermission.Write,
  ProviderPermission.Maintain,
  ProviderPermission.Admin,
]);
