import { z } from 'zod';
import { eventDraftSchema, eventEnvelopeSchema } from '../../kernel/index.js';
import { ResourceStreamKind, resourceId } from '../../resources/index.js';
import { WorkStreamKind, workItemId } from '../../work/index.js';
import { activationId } from './identifiers.js';
import { ActivityStreamKind, activityDecisionId } from './streams.js';

type PullRequestEventName<Suffix extends string> = `pr.${Suffix}`;
type ReviewEventName<Suffix extends string> = `review.${Suffix}`;

interface ActivityEventTypes {
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
    id: z
      .string()
      .regex(/^resource-[a-z0-9-]+$/)
      .transform(resourceId),
  })
  .strict();
const workStreamSchema = z
  .object({
    kind: z.literal(WorkStreamKind.WorkItem),
    id: z
      .string()
      .regex(/^work-[a-z0-9-]+$/)
      .transform(workItemId),
  })
  .strict();
const decisionStreamSchema = z
  .object({
    kind: z.literal(ActivityStreamKind.Decision),
    id: z
      .string()
      .regex(/^.+:pr\.(?:approve|merge)$/)
      .transform(activityDecisionId),
  })
  .strict();
const denialStreamSchema = z.union([resourceStreamSchema, workStreamSchema]);
const workItemIdSchema = z.string().transform(workItemId);
const resourceIdSchema = z.string().transform(resourceId);
const stateSchema = z.enum(['open', 'closed', 'merged']);
const checksSchema = z.enum(['unknown', 'pending', 'passing', 'failing']);
const reviewSchema = z.object({ revision: z.string(), actorId: z.string() }).strict();
const denialSchema = z
  .object({
    activationId: z.string().transform(activationId),
    idempotencyKey: z.string(),
    reason: z.string(),
    target: z
      .union([z.literal('primary'), z.object({ resourceId: resourceIdSchema }).strict()])
      .optional(),
    candidates: z
      .array(z.object({ resourceId: resourceIdSchema, revision: z.string().nullable() }).strict())
      .optional(),
    resourceId: resourceIdSchema.nullable().optional(),
    revision: z.string().nullable().optional(),
    method: z.enum(['merge', 'squash', 'rebase']).optional(),
    body: z.string().nullable().optional(),
  })
  .strict();
const approveRequestedSchema = z
  .object({
    idempotencyKey: z.string(),
    activationId: z.string().transform(activationId),
    resourceId: resourceIdSchema,
    revision: z.string(),
    body: z.string().nullable(),
  })
  .strict();
const mergeRequestedSchema = z
  .object({
    idempotencyKey: z.string(),
    activationId: z.string().transform(activationId),
    resourceId: resourceIdSchema,
    revision: z.string(),
    method: z.enum(['merge', 'squash', 'rebase']),
    requireChecks: z.boolean(),
  })
  .strict();
const outcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('waiting'),
      data: z
        .object({
          intentEventId: z.string(),
          signalKind: z.literal('delivery-result'),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('done'),
      data: z.object({ deliveryEventId: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('blocked'),
      data: z.object({ reason: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('failed'),
      data: z.object({ reason: z.string() }).strict(),
    })
    .strict(),
]);

export function createActivityEventSchema(eventTypes: ActivityEventTypes) {
  const resourceFacts = createResourceFactDraftSchemas(eventTypes);
  const denials = createDenialDraftSchemas(eventTypes);
  const approveFactSchema = z.discriminatedUnion('eventType', [resourceFacts[9], denials[1]]);
  const mergeFactSchema = z.discriminatedUnion('eventType', [resourceFacts[10], denials[0]]);
  const claimBase = {
    activationId: z.string().transform(activationId),
    decisionKind: z.enum(['requested', 'denied']),
    outcome: outcomeSchema,
  } as const;
  const factEnvelopeSchema = z.intersection(
    eventEnvelopeSchema,
    z.preprocess(withoutEnvelopeMetadata, z.union([...resourceFacts, ...denials])),
  );
  return z.union([
    factEnvelopeSchema,
    eventEnvelopeSchema.extend({
      eventType: z.literal(eventTypes.PrApproveDecisionClaimed),
      stream: decisionStreamSchema,
      payload: z
        .object({
          action: z.literal('approve'),
          ...claimBase,
          fact: approveFactSchema,
        })
        .strict(),
    }),
    eventEnvelopeSchema.extend({
      eventType: z.literal(eventTypes.PrMergeDecisionClaimed),
      stream: decisionStreamSchema,
      payload: z
        .object({
          action: z.literal('merge'),
          ...claimBase,
          fact: mergeFactSchema,
        })
        .strict(),
    }),
  ]);
}

function createResourceFactDraftSchemas(eventTypes: ActivityEventTypes) {
  return [
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrDiscovered),
      stream: resourceStreamSchema,
      payload: z
        .object({
          workItemId: workItemIdSchema,
          state: stateSchema,
          headRevision: z.string(),
          baseRevision: z.string(),
          checks: checksSchema,
        })
        .strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrRevisionChanged),
      stream: resourceStreamSchema,
      payload: z.object({ headRevision: z.string(), baseRevision: z.string() }).strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrStateChanged),
      stream: resourceStreamSchema,
      payload: z.object({ state: stateSchema }).strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrChecksChanged),
      stream: resourceStreamSchema,
      payload: z.object({ checks: checksSchema }).strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrReviewAccepted),
      stream: resourceStreamSchema,
      payload: reviewSchema,
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.ReviewAcceptanceSignalRecorded),
      stream: resourceStreamSchema,
      payload: z
        .object({
          revision: z.string(),
          actorId: z.string(),
          actorKind: z.enum(['human', 'bot']),
          acceptedEventId: z.string(),
          providerEventId: z.string(),
          trusted: z.boolean(),
        })
        .strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrReviewChangesRequested),
      stream: resourceStreamSchema,
      payload: reviewSchema,
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrReviewRejected),
      stream: resourceStreamSchema,
      payload: z.object({ reason: z.string() }).strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrMergeAuthorized),
      stream: resourceStreamSchema,
      payload: z.object({ revision: z.string() }).strict(),
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrApproveRequested),
      stream: resourceStreamSchema,
      payload: approveRequestedSchema,
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrMergeRequested),
      stream: resourceStreamSchema,
      payload: mergeRequestedSchema,
    }),
  ] as const;
}

function createDenialDraftSchemas(eventTypes: ActivityEventTypes) {
  return [
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrMergeDenied),
      stream: denialStreamSchema,
      payload: denialSchema,
    }),
    eventDraftSchema.extend({
      eventType: z.literal(eventTypes.PrApproveDenied),
      stream: denialStreamSchema,
      payload: denialSchema,
    }),
  ] as const;
}

function withoutEnvelopeMetadata(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const {
    recordedAt: _recordedAt,
    sequence: _sequence,
    globalPosition: _globalPosition,
    ...draft
  } = input;
  return draft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
