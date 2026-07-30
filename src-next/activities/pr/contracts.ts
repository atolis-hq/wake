import type { ResourceCorrelationView, ResourceView } from '../../resources/index.js';
import type { WorkItemId, WorkItemView } from '../../work/index.js';
import type { ResourceId } from '../../resources/index.js';
import type { ReviewerAuthorizationEvidence } from '../review/contracts.js';

export interface PullRequestView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: 'unknown' | 'pending' | 'passing' | 'failing';
  readonly acceptedReview?: {
    readonly revision: string;
    readonly actorId: string;
    readonly acceptedEventId: string;
  };
}

export interface ObservePullRequest {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly state: PullRequestView['state'];
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: PullRequestView['checks'];
}

export interface AcceptReviewSignal {
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'bot';
  readonly acceptedEventId: string;
  readonly resourceAuthorId: string;
  readonly authorization: ReviewerAuthorizationEvidence;
}

export interface RequestChangesSignal {
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly requestedEventId: string;
}

export type PullRequestCommand =
  | { readonly kind: 'pr.observe'; readonly input: ObservePullRequest }
  | { readonly kind: 'pr.accept-review-signal'; readonly input: AcceptReviewSignal }
  | { readonly kind: 'pr.request-changes-signal'; readonly input: RequestChangesSignal };

export interface PullRequestResourceView {
  readonly resource: ResourceView;
  readonly correlations: readonly ResourceCorrelationView[];
}

export interface AcceptedReviewSignalView {
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: 'human' | 'bot';
  readonly acceptedEventId: string;
  readonly trusted: boolean;
}

export interface PullRequestAuthorityInput {
  readonly work: WorkItemView | null;
  readonly resources: readonly PullRequestResourceView[];
  readonly pullRequests: readonly PullRequestView[];
  readonly acceptedSignals: readonly AcceptedReviewSignalView[];
}

export type PullRequestAuthorityDecision =
  | { readonly allowed: true; readonly resourceId: ResourceId; readonly revision: string }
  | {
      readonly allowed: false;
      readonly reason:
        | 'missing-resource'
        | 'ambiguous-resource'
        | 'correlation-conflict'
        | 'closed'
        | 'stale-approval'
        | 'checks-pending'
        | 'checks-failing'
        | 'untrusted-actor';
    };
