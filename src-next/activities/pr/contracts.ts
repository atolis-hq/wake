import type { ResourceCorrelationView, ResourceId, ResourceView } from '../../resources/index.js';
import type { WorkItemId, WorkItemView } from '../../work/index.js';
import {
  ActivityFailureCode,
  ActivityOutcomeKind,
  ActivityResourceRole,
} from '../contracts/vocabulary.js';
import type { ReviewerAuthorizationEvidence } from '../review/contracts.js';
import { ReviewActorKind } from '../review/contracts.js';
import {
  MergeMethod,
  PullRequestCheckState,
  PullRequestDenialCode,
  PullRequestState,
} from './vocabulary.js';

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
  // Files the head revision changed, when the provider can report them.
  readonly changedFiles?: readonly string[] | undefined;
}

export interface ObservePullRequest {
  readonly resourceId: ResourceId;
  readonly workItemId: WorkItemId;
  readonly state: PullRequestView['state'];
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: PullRequestView['checks'];
  readonly changedFiles?: readonly string[] | undefined;
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
  readonly maxFilesChanged?: number | undefined;
  readonly blockedPaths: readonly string[];
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
      readonly data: { readonly reason: typeof ActivityFailureCode.IntentWriteFailed };
    };

export interface PullRequestMergePolicy {
  readonly maxFilesChanged?: number | undefined;
  readonly blockedPaths: readonly string[];
}

export interface PullRequestAuthorityOptions {
  readonly target: PullRequestTarget;
  readonly requireAcceptedReview: boolean;
  readonly requireChecks: boolean;
  // Absent means no deterministic file-change policy is configured for this
  // decision (approve never sets it; merge sets it from its `with` input).
  readonly mergePolicy?: PullRequestMergePolicy;
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
