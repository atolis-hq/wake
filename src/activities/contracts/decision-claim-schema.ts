import { z } from 'zod';

import { brandedStringSchema, type EntityRef, type EventData } from '../../kernel/index.js';
import type { MergeMethod } from '../pr/vocabulary.js';
import { activationId } from './identifiers.js';

export function newClaimPayload<
  Action extends 'approve' | typeof MergeMethod.Merge,
  Kind extends 'requested' | 'denied',
  Outcome extends z.ZodType,
  FactShape extends z.ZodRawShape,
  Stream extends z.ZodType,
>(
  action: Action,
  decisionKind: Kind,
  outcome: Outcome,
  fact: z.ZodObject<FactShape>,
  factStream: Stream,
) {
  return z
    .object({
      action: z.literal(action),
      activationId: brandedStringSchema(activationId),
      decisionKind: z.literal(decisionKind),
      outcome,
      fact,
      factStream,
    })
    .strict();
}

export function legacyClaimPayload<
  Action extends 'approve' | typeof MergeMethod.Merge,
  Kind extends 'requested' | 'denied',
  Outcome extends z.ZodType,
  Fact extends z.ZodType,
>(action: Action, decisionKind: Kind, outcome: Outcome, fact: Fact) {
  return z
    .object({
      action: z.literal(action),
      activationId: brandedStringSchema(activationId),
      decisionKind: z.literal(decisionKind),
      outcome,
      fact,
    })
    .strict();
}

export function normalizeLegacyFact<Type extends string, Payload, Stream extends EntityRef>(
  legacy: EventData<Type, Payload> & { readonly stream: Stream },
) {
  return {
    fact: {
      eventId: legacy.eventId,
      eventType: legacy.eventType,
      schemaVersion: legacy.schemaVersion,
      occurredAt: legacy.occurredAt,
      correlationId: legacy.correlationId,
      causationId: legacy.causationId,
      actor: legacy.actor,
      source: legacy.source,
      payload: legacy.payload,
    },
    factStream: legacy.stream,
  };
}
