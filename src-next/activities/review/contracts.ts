import type { ResourceId } from '../../resources/index.js';

export type ReviewerAuthorizationEvidence =
  | { readonly source: 'configured-reviewer'; readonly reviewerId: string }
  | {
      readonly source: 'provider-permission';
      readonly permission: 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';
    }
  | { readonly source: 'none' };

export interface ProposedReviewSignal {
  readonly provider: 'github';
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'bot';
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
  readonly providerEventId: string;
  readonly kind: 'accepted' | 'changes-requested';
}

export interface ReviewSignalInput {
  readonly provider: 'github';
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'bot';
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
  readonly providerEventId: string;
  readonly body: string;
}
