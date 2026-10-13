import {
  ProviderPermission,
  ReviewActorKind,
  ReviewerAuthorizationSource,
  type ReviewerAuthorizationEvidence,
} from '../../../activities/index.js';

/** Repository control permits an issue author to clarify their own work. */
export function isWorkControlAuthorized(input: {
  readonly actorKind: string;
  readonly authorization: ReviewerAuthorizationEvidence;
}): boolean {
  if (
    input.actorKind !== ReviewActorKind.Human ||
    input.authorization.source !== ReviewerAuthorizationSource.ProviderPermission
  )
    return false;
  return (
    input.authorization.permission === ProviderPermission.Write ||
    input.authorization.permission === ProviderPermission.Maintain ||
    input.authorization.permission === ProviderPermission.Admin
  );
}
