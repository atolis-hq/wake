import { z } from 'zod';

import { brandedStringSchema, eventDraftSchema } from '../../kernel/index.js';
import { ResourceStreamKind, resourceId } from '../../resources/index.js';
import { WorkStreamKind, workItemId } from '../../work/index.js';
import {
  MergeMethod,
  PullRequestCheckState,
  PullRequestDenialCode,
  PullRequestState,
} from '../pr/vocabulary.js';
import { ReviewActorKind } from '../review/contracts.js';
import { activationId } from './identifiers.js';
import { ActivityStreamKind, activityDecisionId } from './streams.js';
import { ActivityOutcomeKind, ActivityResourceRole } from './vocabulary.js';

type PullRequestEventName<Suffix extends string> = `pr.${Suffix}`;
type ReviewEventName<Suffix extends string> = `review.${Suffix}`;

export interface ActivityEventTypes {
  readonly PrDiscovered: PullRequestEventName<'discovered'>;
  readonly PrRevisionChanged: PullRequestEventName<'revision-changed'>;
  readonly PrStateChanged: PullRequestEventName<'state-changed'>;
  readonly PrChecksChanged: PullRequestEventName<'checks-changed'>;
  readonly PrReviewAccepted: PullRequestEventName<'review-accepted'>;
  readonly ReviewAcceptanceSignalRecorded: ReviewEventName<'acceptance-signal-recorded'>;
  readonly PrReviewChangesRequested: PullRequestEventName<'review-changes-requested'>;
  readonly PrReviewRejected: PullRequestEventName<'review-rejected'>;
  readonly PrMergeDenied: PullRequestEventName<'merge-denied'>;
  readonly PrApproveDenied: PullRequestEventName<'approve-denied'>;
  readonly PrMergeAuthorized: PullRequestEventName<'merge-authorized'>;
  readonly PrApproveRequested: PullRequestEventName<'approve-requested'>;
  readonly PrMergeRequested: PullRequestEventName<'merge-requested'>;
  readonly PrApproveDecisionClaimed: PullRequestEventName<'approve-decision-claimed'>;
  readonly PrMergeDecisionClaimed: PullRequestEventName<'merge-decision-claimed'>;
}

const resourceStreamSchema = z
  .object({
    kind: z.literal(ResourceStreamKind.Resource),
    id: brandedStringSchema(resourceId),
  })
  .strict();
const workStreamSchema = z
  .object({
    kind: z.literal(WorkStreamKind.WorkItem),
    id: brandedStringSchema(workItemId),
  })
  .strict();
const decisionStreamSchema = <Action extends 'approve' | typeof MergeMethod.Merge>(
  action: Action,
) =>
  z
    .object({
      kind: z.literal(ActivityStreamKind.Decision),
      id: brandedStringSchema((id) => activityDecisionId(id, action)),
    })
    .strict();
export const approveDecisionStreamSchema = decisionStreamSchema('approve');
export const mergeDecisionStreamSchema = decisionStreamSchema(MergeMethod.Merge);
const denialStreamSchema = z.union([resourceStreamSchema, workStreamSchema]);
const workItemIdSchema = brandedStringSchema(workItemId);
const resourceIdSchema = brandedStringSchema(resourceId);
const stateSchema = z.enum([
  PullRequestState.Open,
  PullRequestState.Closed,
  PullRequestState.Merged,
]);
const checksSchema = z.enum([
  PullRequestCheckState.Unknown,
  PullRequestCheckState.Pending,
  PullRequestCheckState.Passing,
  PullRequestCheckState.Failing,
]);
const reviewSchema = z.object({ revision: z.string(), actorId: z.string() }).strict();
const denialCodeSchema = z.enum([
  PullRequestDenialCode.MissingResource,
  PullRequestDenialCode.AmbiguousResource,
  PullRequestDenialCode.CorrelationConflict,
  PullRequestDenialCode.Closed,
  PullRequestDenialCode.StaleApproval,
  PullRequestDenialCode.ChecksPending,
  PullRequestDenialCode.ChecksFailing,
  PullRequestDenialCode.UntrustedActor,
]);
const denialSchema = z
  .object({
    activationId: brandedStringSchema(activationId),
    idempotencyKey: z.string(),
    reason: denialCodeSchema,
    target: z
      .union([
        z.literal(ActivityResourceRole.Primary),
        z.object({ resourceId: resourceIdSchema }).strict(),
      ])
      .optional(),
    candidates: z
      .array(z.object({ resourceId: resourceIdSchema, revision: z.string().nullable() }).strict())
      .optional(),
    resourceId: resourceIdSchema.nullable().optional(),
    revision: z.string().nullable().optional(),
    method: z.enum([MergeMethod.Merge, MergeMethod.Squash, MergeMethod.Rebase]).optional(),
    body: z.string().nullable().optional(),
  })
  .strict();
const approveRequestedSchema = z
  .object({
    idempotencyKey: z.string(),
    activationId: brandedStringSchema(activationId),
    resourceId: resourceIdSchema,
    revision: z.string(),
    body: z.string().nullable(),
  })
  .strict();
const mergeRequestedSchema = z
  .object({
    idempotencyKey: z.string(),
    activationId: brandedStringSchema(activationId),
    resourceId: resourceIdSchema,
    revision: z.string(),
    method: z.enum([MergeMethod.Merge, MergeMethod.Squash, MergeMethod.Rebase]),
    requireChecks: z.boolean(),
  })
  .strict();
export const requestedOutcomeSchema = z
  .object({
    kind: z.literal(ActivityOutcomeKind.Waiting),
    data: z
      .object({
        intentEventId: z.string(),
        signalKind: z.literal('delivery-result'),
      })
      .strict(),
  })
  .strict();
export const deniedOutcomeSchema = z
  .object({
    kind: z.literal(ActivityOutcomeKind.Blocked),
    data: z.object({ reason: denialCodeSchema }).strict(),
  })
  .strict();

export function createResourceFactDraftSchemas(eventTypes: ActivityEventTypes) {
  return [
    resourceFactDraft(
      eventTypes.PrDiscovered,
      z
        .object({
          workItemId: workItemIdSchema,
          state: stateSchema,
          headRevision: z.string(),
          baseRevision: z.string(),
          checks: checksSchema,
        })
        .strict(),
    ),
    resourceFactDraft(
      eventTypes.PrRevisionChanged,
      z.object({ headRevision: z.string(), baseRevision: z.string() }).strict(),
    ),
    resourceFactDraft(eventTypes.PrStateChanged, z.object({ state: stateSchema }).strict()),
    resourceFactDraft(eventTypes.PrChecksChanged, z.object({ checks: checksSchema }).strict()),
    resourceFactDraft(eventTypes.PrReviewAccepted, reviewSchema),
    resourceFactDraft(
      eventTypes.ReviewAcceptanceSignalRecorded,
      z
        .object({
          revision: z.string(),
          actorId: z.string(),
          actorKind: z.enum([ReviewActorKind.Human, ReviewActorKind.Bot]),
          acceptedEventId: z.string(),
          providerEventId: z.string(),
          trusted: z.boolean(),
        })
        .strict(),
    ),
    resourceFactDraft(eventTypes.PrReviewChangesRequested, reviewSchema),
    resourceFactDraft(eventTypes.PrReviewRejected, z.object({ reason: denialCodeSchema }).strict()),
    resourceFactDraft(eventTypes.PrMergeAuthorized, z.object({ revision: z.string() }).strict()),
    resourceFactDraft(eventTypes.PrApproveRequested, approveRequestedSchema),
    resourceFactDraft(eventTypes.PrMergeRequested, mergeRequestedSchema),
  ] as const;
}

export function createDenialDraftSchemas(eventTypes: ActivityEventTypes) {
  return [
    denialFactDraft(eventTypes.PrMergeDenied),
    denialFactDraft(eventTypes.PrApproveDenied),
  ] as const;
}

function resourceFactDraft<Type extends string, Payload extends z.ZodType>(
  eventType: Type,
  payload: Payload,
) {
  return eventDraftSchema
    .extend({
      eventType: z.literal(eventType),
      stream: resourceStreamSchema,
      payload,
    })
    .superRefine((event, context) =>
      resourcePayloadIdentity(
        event as {
          readonly stream: { readonly kind: string; readonly id: string };
          readonly payload: unknown;
        },
        context,
      ),
    );
}

function denialFactDraft<Type extends string>(eventType: Type) {
  return eventDraftSchema
    .extend({
      eventType: z.literal(eventType),
      stream: denialStreamSchema,
      payload: denialSchema,
    })
    .superRefine(resourcePayloadIdentity);
}

function resourcePayloadIdentity(
  event: {
    readonly stream: { readonly kind: string; readonly id: string };
    readonly payload: unknown;
  },
  context: z.RefinementCtx,
): void {
  if (
    event.stream.kind !== ResourceStreamKind.Resource ||
    !isRecord(event.payload) ||
    typeof event.payload.resourceId !== 'string'
  )
    return;
  if (event.payload.resourceId !== event.stream.id)
    context.addIssue({
      code: 'custom',
      path: ['payload', 'resourceId'],
      message: 'Activity resource payload id must identify its stream',
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
