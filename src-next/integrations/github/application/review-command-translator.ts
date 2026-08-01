import {
  ReviewDecisionKind,
  type ProposedReviewSignal,
  type ReviewActorKind,
  type ReviewerAuthorizationEvidence,
} from '../../../activities/index.js';
import type { ResourceId } from '../../../resources/index.js';

interface GitHubReviewCommandInput {
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: ReviewActorKind;
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
  readonly providerEventId: string;
  readonly body: string;
}

export function translateGitHubReviewCommand(
  input: GitHubReviewCommandInput,
): ProposedReviewSignal | null {
  const command = input.body.trim();
  if (command !== '/accepted' && command !== '/changes') return null;
  return {
    resourceId: input.resourceId,
    revision: input.revision,
    actorId: input.actorId,
    actorKind: input.actorKind,
    resourceAuthorId: input.resourceAuthorId,
    authorization: input.authorization,
    providerEventId: input.providerEventId,
    kind:
      command === '/accepted' ? ReviewDecisionKind.Accepted : ReviewDecisionKind.ChangesRequested,
  };
}
