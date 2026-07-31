import {
  MergeMethod,
  PullRequestCheckState,
  PullRequestDenialCode,
  PullRequestState,
} from './vocabulary.js';
import { ReviewActorKind } from '../review/contracts.js';
import {
  ActivityOutcomeKind,
  ActivityResourceRole,
  type ActivityFailureCode,
} from '../contracts/vocabulary.js';
import type { ResourceCorrelationView, ResourceView } from '../../resources/index.js';
import type { WorkItemId, WorkItemView } from '../../work/index.js';
import type { ResourceId } from '../../resources/index.js';
import type { ReviewerAuthorizationEvidence } from '../review/contracts.js';

export interface PullRequestView {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly state: PullRequestState;
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: PullRequestCheckState;
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
  readonly actorKind: ReviewActorKind;
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

export type PullRequestTarget =
  typeof ActivityResourceRole.Primary | { readonly resourceId: ResourceId };
export interface PullRequestTargetInput {
  readonly target: PullRequestTarget;
}
export interface PullRequestApproveInput extends PullRequestTargetInput {
  readonly body?: string;
}
export interface PullRequestMergeInput extends PullRequestTargetInput {
  readonly method: MergeMethod;
  readonly requireChecks: boolean;
}
export type PullRequestActivityOutcome =
  | {
      readonly kind: typeof ActivityOutcomeKind.Waiting;
      readonly data: { readonly intentEventId: string; readonly signalKind: 'delivery-result' };
    }
  | {
      readonly kind: typeof ActivityOutcomeKind.Done;
      readonly data: { readonly deliveryEventId: string };
    }
  | {
      readonly kind: typeof ActivityOutcomeKind.Blocked;
      readonly data: { readonly reason: PullRequestDenialCode };
    }
  | {
      readonly kind: typeof ActivityOutcomeKind.Failed;
      readonly data: { readonly reason: ActivityFailureCode };
    };

export interface PullRequestAuthorityOptions {
  readonly target: PullRequestTarget;
  readonly requireAcceptedReview: boolean;
  readonly requireChecks: boolean;
}

export interface AcceptedReviewSignalView {
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly actorId: string;
  readonly actorKind: ReviewActorKind;
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
      readonly reason: PullRequestDenialCode;
    };
