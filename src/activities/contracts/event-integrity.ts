import type { z } from 'zod';

import { ResourceStreamKind } from '../../resources/index.js';
import type { MergeMethod } from '../pr/vocabulary.js';
import { activationId } from './identifiers.js';
import { activityDecisionStream } from './streams.js';

export function resourcePayloadIdentity(
  fact: {
    readonly stream: { readonly kind: string; readonly id: string };
    readonly payload: unknown;
  },
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = [],
): void {
  if (
    fact.stream.kind !== ResourceStreamKind.Resource ||
    typeof fact.payload !== 'object' ||
    fact.payload === null ||
    !('resourceId' in fact.payload) ||
    typeof fact.payload.resourceId !== 'string'
  )
    return;
  if (fact.payload.resourceId !== fact.stream.id)
    context.addIssue({
      code: 'custom',
      path: [...path, 'payload', 'resourceId'],
      message: 'Activity resource payload id must identify its stream',
    });
}

export function decisionClaimIdentity(
  envelope: {
    readonly stream: { readonly id: string };
    readonly event: { readonly payload: DecisionClaimPayload };
  },
  context: z.RefinementCtx,
): void {
  if (
    envelope.stream.id !==
    activityDecisionStream(
      activationId(envelope.event.payload.activationId),
      envelope.event.payload.action,
    ).id
  )
    context.addIssue({
      code: 'custom',
      path: ['event', 'payload', 'activationId'],
      message: 'Activity decision activation and action must identify its stream',
    });
  decisionClaimDataIdentity(envelope.event, context);
}

type DecisionClaimPayload =
  | {
      readonly action: 'approve' | typeof MergeMethod.Merge;
      readonly activationId: string;
      readonly decisionKind: 'requested';
      readonly outcome: { readonly data: { readonly intentEventId: string } };
      readonly fact: {
        readonly eventId: string;
        readonly payload: { readonly activationId: string };
      };
      readonly factStream: { readonly kind: string; readonly id: string };
    }
  | {
      readonly action: 'approve' | typeof MergeMethod.Merge;
      readonly activationId: string;
      readonly decisionKind: 'denied';
      readonly outcome: { readonly data: { readonly reason: string } };
      readonly fact: {
        readonly eventId: string;
        readonly payload: { readonly activationId: string; readonly reason: string };
      };
      readonly factStream: { readonly kind: string; readonly id: string };
    };

export function decisionClaimDataIdentity(
  event: { readonly payload: DecisionClaimPayload },
  context: z.RefinementCtx,
): void {
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
  resourcePayloadIdentity(
    { stream: event.payload.factStream, payload: event.payload.fact.payload },
    context,
    ['payload', 'fact'],
  );
}
