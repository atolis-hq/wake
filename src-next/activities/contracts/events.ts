import { z } from 'zod';
import {
  type EventDraft,
  type EventDraftUnion,
  type EventEnvelope,
  type EventUnion,
} from '../../kernel/index.js';
import { type ResourceId, type ResourceStreamRef } from '../../resources/index.js';
import { type WorkItemId, type WorkItemStreamRef } from '../../work/index.js';
import { type ActivityDecisionStreamRef, type PullRequestDecisionAction } from './streams.js';
import type { ActivationId } from './identifiers.js';
import type { PullRequestActivityOutcome, PullRequestTarget } from '../pr/contracts.js';
import { createActivityEventSchemas } from './event-schema.js';

export const ActivityEventType = {
  PrDiscovered: 'pr.discovered',
  PrRevisionChanged: 'pr.revision-changed',
  PrStateChanged: 'pr.state-changed',
  PrChecksChanged: 'pr.checks-changed',
  PrReviewAccepted: 'pr.review-accepted',
  ReviewAcceptanceSignalRecorded: 'review.acceptance-signal-recorded',
  PrReviewChangesRequested: 'pr.review-changes-requested',
  PrReviewRejected: 'pr.review-rejected',
  PrMergeDenied: 'pr.merge-denied',
  PrApproveDenied: 'pr.approve-denied',
  PrMergeAuthorized: 'pr.merge-authorized',
  PrApproveRequested: 'pr.approve-requested',
  PrMergeRequested: 'pr.merge-requested',
  PrApproveDecisionClaimed: 'pr.approve-decision-claimed',
  PrMergeDecisionClaimed: 'pr.merge-decision-claimed',
} as const;
export type ActivityEventTypes = typeof ActivityEventType;

export interface PullRequestDiscoveredPayload {
  readonly workItemId: WorkItemId;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRevision: string;
  readonly baseRevision: string;
  readonly checks: 'unknown' | 'pending' | 'passing' | 'failing';
}

export interface PullRequestDenialPayload {
  readonly activationId: ActivationId;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly target?: PullRequestTarget | undefined;
  readonly candidates?:
    | readonly {
        readonly resourceId: ResourceId;
        readonly revision: string | null;
      }[]
    | undefined;
  readonly resourceId?: ResourceId | null | undefined;
  readonly revision?: string | null | undefined;
  readonly method?: 'merge' | 'squash' | 'rebase' | undefined;
  readonly body?: string | null | undefined;
}

export interface PullRequestApproveRequestedPayload {
  readonly idempotencyKey: string;
  readonly activationId: ActivationId;
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly body: string | null;
}

export interface PullRequestMergeRequestedPayload {
  readonly idempotencyKey: string;
  readonly activationId: ActivationId;
  readonly resourceId: ResourceId;
  readonly revision: string;
  readonly method: 'merge' | 'squash' | 'rebase';
  readonly requireChecks: boolean;
}

type RequestedOutcome = Extract<PullRequestActivityOutcome, { readonly kind: 'waiting' }>;
type DeniedOutcome = Extract<PullRequestActivityOutcome, { readonly kind: 'blocked' }>;
type RequestedFact<Action extends PullRequestDecisionAction> = Action extends 'approve'
  ? EventDraft<
      typeof ActivityEventType.PrApproveRequested,
      PullRequestApproveRequestedPayload,
      ResourceStreamRef
    >
  : EventDraft<
      typeof ActivityEventType.PrMergeRequested,
      PullRequestMergeRequestedPayload,
      ResourceStreamRef
    >;
type DeniedFact<Action extends PullRequestDecisionAction> = EventDraft<
  Action extends 'approve'
    ? typeof ActivityEventType.PrApproveDenied
    : typeof ActivityEventType.PrMergeDenied,
  PullRequestDenialPayload,
  ResourceStreamRef | WorkItemStreamRef
>;
type PullRequestDecisionClaimPayload<Action extends PullRequestDecisionAction> =
  | {
      readonly action: Action;
      readonly activationId: ActivationId;
      readonly decisionKind: 'requested';
      readonly outcome: RequestedOutcome;
      readonly fact: RequestedFact<Action>;
    }
  | {
      readonly action: Action;
      readonly activationId: ActivationId;
      readonly decisionKind: 'denied';
      readonly outcome: DeniedOutcome;
      readonly fact: DeniedFact<Action>;
    };

export interface ActivityEventPayloads {
  readonly [ActivityEventType.PrDiscovered]: PullRequestDiscoveredPayload;
  readonly [ActivityEventType.PrRevisionChanged]: {
    readonly headRevision: string;
    readonly baseRevision: string;
  };
  readonly [ActivityEventType.PrStateChanged]: {
    readonly state: PullRequestDiscoveredPayload['state'];
  };
  readonly [ActivityEventType.PrChecksChanged]: {
    readonly checks: PullRequestDiscoveredPayload['checks'];
  };
  readonly [ActivityEventType.PrReviewAccepted]: {
    readonly revision: string;
    readonly actorId: string;
  };
  readonly [ActivityEventType.ReviewAcceptanceSignalRecorded]: {
    readonly revision: string;
    readonly actorId: string;
    readonly actorKind: 'human' | 'bot';
    readonly acceptedEventId: string;
    readonly providerEventId: string;
    readonly trusted: boolean;
  };
  readonly [ActivityEventType.PrReviewChangesRequested]: {
    readonly revision: string;
    readonly actorId: string;
  };
  readonly [ActivityEventType.PrReviewRejected]: { readonly reason: string };
  readonly [ActivityEventType.PrMergeDenied]: PullRequestDenialPayload;
  readonly [ActivityEventType.PrApproveDenied]: PullRequestDenialPayload;
  readonly [ActivityEventType.PrMergeAuthorized]: { readonly revision: string };
  readonly [ActivityEventType.PrApproveRequested]: PullRequestApproveRequestedPayload;
  readonly [ActivityEventType.PrMergeRequested]: PullRequestMergeRequestedPayload;
  readonly [ActivityEventType.PrApproveDecisionClaimed]: PullRequestDecisionClaimPayload<'approve'>;
  readonly [ActivityEventType.PrMergeDecisionClaimed]: PullRequestDecisionClaimPayload<'merge'>;
}

type ResourceFactType =
  | typeof ActivityEventType.PrDiscovered
  | typeof ActivityEventType.PrRevisionChanged
  | typeof ActivityEventType.PrStateChanged
  | typeof ActivityEventType.PrChecksChanged
  | typeof ActivityEventType.PrReviewAccepted
  | typeof ActivityEventType.ReviewAcceptanceSignalRecorded
  | typeof ActivityEventType.PrReviewChangesRequested
  | typeof ActivityEventType.PrReviewRejected
  | typeof ActivityEventType.PrMergeAuthorized
  | typeof ActivityEventType.PrApproveRequested
  | typeof ActivityEventType.PrMergeRequested;
type DenialType = typeof ActivityEventType.PrMergeDenied | typeof ActivityEventType.PrApproveDenied;

type ResourceFactPayloads = Pick<ActivityEventPayloads, ResourceFactType>;
type DenialPayloads = Pick<ActivityEventPayloads, DenialType>;
type ApproveDecisionPayloads = Pick<
  ActivityEventPayloads,
  typeof ActivityEventType.PrApproveDecisionClaimed
>;
type MergeDecisionPayloads = Pick<
  ActivityEventPayloads,
  typeof ActivityEventType.PrMergeDecisionClaimed
>;

export type ActivityFact =
  | EventUnion<ResourceFactPayloads, ResourceStreamRef>
  | EventUnion<DenialPayloads, ResourceStreamRef | WorkItemStreamRef>;
export type ActivityFactDraft =
  | EventDraftUnion<ResourceFactPayloads, ResourceStreamRef>
  | EventDraftUnion<DenialPayloads, ResourceStreamRef | WorkItemStreamRef>;
export type ActivityEvent =
  | ActivityFact
  | EventUnion<ApproveDecisionPayloads, ActivityDecisionStreamRef<'approve'>>
  | EventUnion<MergeDecisionPayloads, ActivityDecisionStreamRef<'merge'>>;
export type ActivityEventDraft =
  | ActivityFactDraft
  | EventDraftUnion<ApproveDecisionPayloads, ActivityDecisionStreamRef<'approve'>>
  | EventDraftUnion<MergeDecisionPayloads, ActivityDecisionStreamRef<'merge'>>;

const { draftSchema, eventSchema } = createActivityEventSchemas(ActivityEventType);

export function decodeActivityEvent(event: EventEnvelope): ActivityEvent {
  const result = eventSchema.safeParse(event);
  if (!result.success) throw invalidActivityEvent(event, result.error);
  return result.data;
}

export function selectActivityEvent(event: EventEnvelope): ActivityEvent | null {
  return ownsActivityEventType(event.eventType) ? decodeActivityEvent(event) : null;
}

export function decodeActivityEventDraft(draft: EventDraft): ActivityEventDraft {
  const result = draftSchema.safeParse(draft);
  if (!result.success)
    throw new Error(
      `Invalid Activity event draft ${draft.eventId} (${draft.eventType}): ${result.error.message}`,
      { cause: result.error },
    );
  return result.data;
}

function ownsActivityEventType(eventType: string): boolean {
  return (
    eventType.startsWith('activities.') ||
    eventType.startsWith('pr.') ||
    eventType.startsWith('review.')
  );
}

function invalidActivityEvent(event: EventEnvelope, cause: z.ZodError): Error {
  return new Error(
    `Invalid Activity event ${event.eventId} at global position ${event.globalPosition} (${event.eventType}): ${cause.message}`,
    { cause },
  );
}

export interface ActivityActivated {
  readonly activationId: ActivationId;
  readonly activity: string;
}
