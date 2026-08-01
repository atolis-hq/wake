import { defineClosedVocabulary, type ValueOf } from '../../kernel/index.js';
import type { ResourceId } from '../../resources/index.js';

export const ReviewerAuthorizationSource = defineClosedVocabulary({
  ConfiguredReviewer: 'configured-reviewer',
  ProviderPermission: 'provider-permission',
  None: 'none',
} as const);
export type ReviewerAuthorizationSource = ValueOf<typeof ReviewerAuthorizationSource>;

export const ProviderPermission = defineClosedVocabulary({
  None: 'none',
  Read: 'read',
  Triage: 'triage',
  Write: 'write',
  Maintain: 'maintain',
  Admin: 'admin',
} as const);
export type ProviderPermission = ValueOf<typeof ProviderPermission>;

export const ReviewActorKind = defineClosedVocabulary({
  Human: 'human',
  Bot: 'bot',
} as const);
export type ReviewActorKind = ValueOf<typeof ReviewActorKind>;

export const ReviewDecisionKind = defineClosedVocabulary({
  Accepted: 'accepted',
  ChangesRequested: 'changes-requested',
} as const);
export type ReviewDecisionKind = ValueOf<typeof ReviewDecisionKind>;

export type ReviewerAuthorizationEvidence =
  | {
      readonly source: typeof ReviewerAuthorizationSource.ConfiguredReviewer;
      readonly reviewerId: string;
    }
  | {
      readonly source: typeof ReviewerAuthorizationSource.ProviderPermission;
      readonly permission: ProviderPermission;
    }
  | { readonly source: typeof ReviewerAuthorizationSource.None };

export interface ProposedReviewSignal {
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: ReviewActorKind;
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
  readonly providerEventId: string;
  readonly kind: ReviewDecisionKind;
}
