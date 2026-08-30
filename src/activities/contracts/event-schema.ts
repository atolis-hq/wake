import { z } from 'zod';

import { brandedStringSchema, eventDataSchema, eventEnvelopeSchema } from '../../kernel/index.js';
import { ResourceStreamKind, resourceId } from '../../resources/index.js';
import { WorkStreamKind, workItemId } from '../../work/index.js';
import {
  MergeMethod,
  PullRequestCheckState,
  PullRequestDenialCode,
  PullRequestState,
} from '../pr/vocabulary.js';
import { ReviewActorKind } from '../review/contracts.js';
import {
  legacyClaimPayload,
  newClaimPayload,
  normalizeLegacyFact,
} from './decision-claim-schema.js';
import {
  decisionClaimDataIdentity,
  decisionClaimIdentity,
  resourcePayloadIdentity,
} from './event-integrity.js';
import { activationId } from './identifiers.js';
import { ActivityStreamKind, activityDecisionId } from './streams.js';
import { ActivityOutcomeKind, ActivityResourceRole } from './vocabulary.js';

type PullRequestEventName<Suffix extends string> = `pr.${Suffix}`;

type ReviewEventName<Suffix extends string> = `review.${Suffix}`;

type IssueEventName<Suffix extends string> = `issue.${Suffix}`;

export interface ActivityEventTypes {
  readonly IssueCompleteRequested: IssueEventName<'complete-requested'>;
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
  PullRequestDenialCode.TooManyFilesChanged,
  PullRequestDenialCode.BlockedPathChanged,
  PullRequestDenialCode.ChangedFilesUnavailable,
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
    workflowInstanceId: z.string().min(1),
    resourceId: resourceIdSchema,
    revision: z.string(),
    body: z.string().nullable(),
  })
  .strict();
const mergeRequestedSchema = z
  .object({
    idempotencyKey: z.string(),
    activationId: brandedStringSchema(activationId),
    workflowInstanceId: z.string().min(1),
    resourceId: resourceIdSchema,
    revision: z.string(),
    method: z.enum([MergeMethod.Merge, MergeMethod.Squash, MergeMethod.Rebase]),
    requireChecks: z.boolean(),
    autoMerge: z.boolean().default(false),
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
      eventTypes.IssueCompleteRequested,
      z
        .object({
          idempotencyKey: z.string(),
          activationId: brandedStringSchema(activationId),
          workflowInstanceId: z.string().min(1),
          resourceId: resourceIdSchema,
        })
        .strict(),
    ),
    resourceFactDraft(
      eventTypes.PrDiscovered,
      z
        .object({
          workItemId: workItemIdSchema,
          state: stateSchema,
          headRevision: z.string(),
          baseRevision: z.string(),
          checks: checksSchema,
          changedFiles: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    resourceFactDraft(
      eventTypes.PrRevisionChanged,
      z
        .object({
          headRevision: z.string(),
          baseRevision: z.string(),
          changedFiles: z.array(z.string()).optional(),
        })
        .strict(),
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
  return eventDataSchema.extend({ eventType: z.literal(eventType), payload });
}

function denialFactDraft<Type extends string>(eventType: Type) {
  return eventDataSchema.extend({ eventType: z.literal(eventType), payload: denialSchema });
}

export function createActivityEventSchemas(eventTypes: ActivityEventTypes) {
  const resourceFacts = createResourceFactDraftSchemas(eventTypes);
  const denials = createDenialDraftSchemas(eventTypes);
  const claims = createDecisionClaimSchemas(eventTypes, resourceFacts, denials);
  const resourceFactEnvelope = eventEnvelopeSchema
    .extend({ event: z.union(resourceFacts), stream: resourceStreamSchema })
    .superRefine((envelope, context) =>
      resourcePayloadIdentity(
        { stream: envelope.stream, payload: envelope.event.payload },
        context,
        ['event'],
      ),
    );
  const denialEnvelope = eventEnvelopeSchema
    .extend({ event: z.union(denials), stream: denialStreamSchema })
    .superRefine((envelope, context) =>
      resourcePayloadIdentity(
        { stream: envelope.stream, payload: envelope.event.payload },
        context,
        ['event'],
      ),
    );
  return {
    eventSchema: z.union([
      resourceFactEnvelope,
      denialEnvelope,
      claims.approveEnvelope,
      claims.mergeEnvelope,
    ]),
    draftSchema: z.union([...resourceFacts, ...denials, claims.approveDraft, claims.mergeDraft]),
  };
}

function createDecisionClaimSchemas(
  eventTypes: ActivityEventTypes,
  resourceFacts: ReturnType<typeof createResourceFactDraftSchemas>,
  denials: ReturnType<typeof createDenialDraftSchemas>,
) {
  const { approveDraftPayload, mergeDraftPayload, approveEnvelopePayload, mergeEnvelopePayload } =
    createDecisionClaimPayloadSchemas(resourceFacts, denials);
  const approveDraft = eventDataSchema
    .extend({
      eventType: z.literal(eventTypes.PrApproveDecisionClaimed),
      payload: approveDraftPayload,
    })
    .superRefine(decisionClaimDataIdentity);
  const mergeDraft = eventDataSchema
    .extend({
      eventType: z.literal(eventTypes.PrMergeDecisionClaimed),
      payload: mergeDraftPayload,
    })
    .superRefine(decisionClaimDataIdentity);
  const approveEnvelope = eventEnvelopeSchema
    .extend({
      event: eventDataSchema.extend({
        eventType: z.literal(eventTypes.PrApproveDecisionClaimed),
        payload: approveEnvelopePayload,
      }),
      stream: approveDecisionStreamSchema,
    })
    .superRefine(decisionClaimIdentity);
  const mergeEnvelope = eventEnvelopeSchema
    .extend({
      event: eventDataSchema.extend({
        eventType: z.literal(eventTypes.PrMergeDecisionClaimed),
        payload: mergeEnvelopePayload,
      }),
      stream: mergeDecisionStreamSchema,
    })
    .superRefine(decisionClaimIdentity);
  return { approveEnvelope, mergeEnvelope, approveDraft, mergeDraft };
}

function createDecisionClaimPayloadSchemas(
  resourceFacts: ReturnType<typeof createResourceFactDraftSchemas>,
  denials: ReturnType<typeof createDenialDraftSchemas>,
) {
  const approveRequested = newClaimPayload(
    'approve',
    'requested',
    requestedOutcomeSchema,
    resourceFacts[10],
    resourceStreamSchema,
  );
  const approveDenied = newClaimPayload(
    'approve',
    'denied',
    deniedOutcomeSchema,
    denials[1],
    denialStreamSchema,
  );
  const mergeRequested = newClaimPayload(
    MergeMethod.Merge,
    'requested',
    requestedOutcomeSchema,
    resourceFacts[11],
    resourceStreamSchema,
  );
  const mergeDenied = newClaimPayload(
    MergeMethod.Merge,
    'denied',
    deniedOutcomeSchema,
    denials[0],
    denialStreamSchema,
  );
  const approveDraftPayload = z.union([approveRequested, approveDenied]);
  const mergeDraftPayload = z.union([mergeRequested, mergeDenied]);
  const approveEnvelopePayload = z.union([
    approveDraftPayload,
    legacyClaimPayload(
      'approve',
      'requested',
      requestedOutcomeSchema,
      resourceFacts[10].extend({ stream: resourceStreamSchema }),
    ).transform((claim) => ({ ...claim, ...normalizeLegacyFact(claim.fact) })),
    legacyClaimPayload(
      'approve',
      'denied',
      deniedOutcomeSchema,
      denials[1].extend({ stream: denialStreamSchema }),
    ).transform((claim) => ({ ...claim, ...normalizeLegacyFact(claim.fact) })),
  ]);
  const mergeEnvelopePayload = z.union([
    mergeDraftPayload,
    legacyClaimPayload(
      MergeMethod.Merge,
      'requested',
      requestedOutcomeSchema,
      resourceFacts[11].extend({ stream: resourceStreamSchema }),
    ).transform((claim) => ({ ...claim, ...normalizeLegacyFact(claim.fact) })),
    legacyClaimPayload(
      MergeMethod.Merge,
      'denied',
      deniedOutcomeSchema,
      denials[0].extend({ stream: denialStreamSchema }),
    ).transform((claim) => ({ ...claim, ...normalizeLegacyFact(claim.fact) })),
  ]);
  return {
    approveDraftPayload,
    mergeDraftPayload,
    approveEnvelopePayload,
    mergeEnvelopePayload,
  };
}
