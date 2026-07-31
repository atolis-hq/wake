import { z } from 'zod';

import { brandedStringSchema, eventDraftSchema, eventEnvelopeSchema } from '../../kernel/index.js';
import { ActivityOutcomeKind } from './vocabulary.js';
import { activationId } from './identifiers.js';
import { activityDecisionStream } from './streams.js';
import { MergeMethod } from '../pr/vocabulary.js';
import {
  approveDecisionStreamSchema,
  createDenialDraftSchemas,
  createResourceFactDraftSchemas,
  deniedOutcomeSchema,
  mergeDecisionStreamSchema,
  requestedOutcomeSchema,
  type ActivityEventTypes,
} from './event-fact-schemas.js';

export function createActivityEventSchemas(eventTypes: ActivityEventTypes) {
  const resourceFacts = createResourceFactDraftSchemas(eventTypes);
  const denials = createDenialDraftSchemas(eventTypes);
  const claims = createDecisionClaimSchemas(eventTypes, resourceFacts, denials);
  const factEnvelopeSchema = z.intersection(
    eventEnvelopeSchema,
    z.preprocess(withoutEnvelopeMetadata, z.union([...resourceFacts, ...denials])),
  );
  return {
    eventSchema: z.union([factEnvelopeSchema, claims.approveEnvelope, claims.mergeEnvelope]),
    draftSchema: z.union([...resourceFacts, ...denials, claims.approveDraft, claims.mergeDraft]),
  };
}

function createDecisionClaimSchemas(
  eventTypes: ActivityEventTypes,
  resourceFacts: ReturnType<typeof createResourceFactDraftSchemas>,
  denials: ReturnType<typeof createDenialDraftSchemas>,
) {
  const approveClaimPayloadSchema = z.discriminatedUnion('decisionKind', [
    z
      .object({
        action: z.literal('approve'),
        activationId: brandedStringSchema(activationId),
        decisionKind: z.literal('requested'),
        outcome: requestedOutcomeSchema,
        fact: resourceFacts[9],
      })
      .strict(),
    z
      .object({
        action: z.literal('approve'),
        activationId: brandedStringSchema(activationId),
        decisionKind: z.literal('denied'),
        outcome: deniedOutcomeSchema,
        fact: denials[1],
      })
      .strict(),
  ]);
  const mergeClaimPayloadSchema = z.discriminatedUnion('decisionKind', [
    z
      .object({
        action: z.literal(MergeMethod.Merge),
        activationId: brandedStringSchema(activationId),
        decisionKind: z.literal('requested'),
        outcome: requestedOutcomeSchema,
        fact: resourceFacts[10],
      })
      .strict(),
    z
      .object({
        action: z.literal(MergeMethod.Merge),
        activationId: brandedStringSchema(activationId),
        decisionKind: z.literal('denied'),
        outcome: deniedOutcomeSchema,
        fact: denials[0],
      })
      .strict(),
  ]);
  const approveClaimContract = {
    eventType: z.literal(eventTypes.PrApproveDecisionClaimed),
    stream: approveDecisionStreamSchema,
    payload: approveClaimPayloadSchema,
  };
  const mergeClaimContract = {
    eventType: z.literal(eventTypes.PrMergeDecisionClaimed),
    stream: mergeDecisionStreamSchema,
    payload: mergeClaimPayloadSchema,
  };
  const approveEnvelope = eventEnvelopeSchema
    .extend(approveClaimContract)
    .superRefine(decisionClaimIdentity);
  const mergeEnvelope = eventEnvelopeSchema
    .extend(mergeClaimContract)
    .superRefine(decisionClaimIdentity);
  const approveDraft = eventDraftSchema
    .extend(approveClaimContract)
    .superRefine(decisionClaimIdentity);
  const mergeDraft = eventDraftSchema.extend(mergeClaimContract).superRefine(decisionClaimIdentity);
  return { approveEnvelope, mergeEnvelope, approveDraft, mergeDraft };
}

function decisionClaimIdentity(
  event: {
    readonly stream: { readonly id: string };
    readonly payload:
      | {
          readonly action: 'approve' | typeof MergeMethod.Merge;
          readonly activationId: string;
          readonly decisionKind: 'requested';
          readonly outcome: {
            readonly kind: typeof ActivityOutcomeKind.Waiting;
            readonly data: { readonly intentEventId: string };
          };
          readonly fact: {
            readonly eventId: string;
            readonly payload: { readonly activationId: string };
          };
        }
      | {
          readonly action: 'approve' | typeof MergeMethod.Merge;
          readonly activationId: string;
          readonly decisionKind: 'denied';
          readonly outcome: {
            readonly kind: typeof ActivityOutcomeKind.Blocked;
            readonly data: { readonly reason: string };
          };
          readonly fact: {
            readonly eventId: string;
            readonly payload: { readonly activationId: string; readonly reason: string };
          };
        };
  },
  context: z.RefinementCtx,
): void {
  if (
    event.stream.id !==
    activityDecisionStream(activationId(event.payload.activationId), event.payload.action).id
  )
    context.addIssue({
      code: 'custom',
      path: ['payload', 'activationId'],
      message: 'Activity decision activation and action must identify its stream',
    });
  if (event.payload.fact.payload.activationId !== event.payload.activationId)
    context.addIssue({
      code: 'custom',
      path: ['payload', 'fact', 'payload', 'activationId'],
      message: 'Activity decision fact activation must match its claim',
    });
  if (
    event.payload.decisionKind === 'requested' &&
    event.payload.outcome.data.intentEventId !== event.payload.fact.eventId
  )
    context.addIssue({
      code: 'custom',
      path: ['payload', 'outcome', 'data', 'intentEventId'],
      message: 'Requested decision intent event id must match its fact',
    });
  if (
    event.payload.decisionKind === 'denied' &&
    event.payload.outcome.data.reason !== event.payload.fact.payload.reason
  )
    context.addIssue({
      code: 'custom',
      path: ['payload', 'outcome', 'data', 'reason'],
      message: 'Denied decision reason must match its fact',
    });
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
