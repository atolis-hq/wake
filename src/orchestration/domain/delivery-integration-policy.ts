import { ParentActionKind, type ParentActionRequest } from '../../activities/index.js';
import type { DeliveryOutputKey } from '../contracts/delivery.js';
import { DelegationOutputKind } from '../contracts/vocabulary.js';
import type { DeliveryFacts } from './delivery-facts.js';

export function targetRequirements(
  facts: DeliveryFacts,
  key: DeliveryOutputKey,
  action: ParentActionRequest['action'],
) {
  const required = facts.reservations
    .flatMap((reservation) => reservation.children)
    .find((child) => child.workItemId === key.childWorkItemId)
    ?.outputs.find((output) => output.name === key.outputName);
  const merging = action === ParentActionKind.Merge;
  if (required !== undefined && 'kind' in required && required.kind === DelegationOutputKind.Change)
    return {
      requireReview: merging && (required.requireReview ?? true),
      requireChecks: merging && (required.requireChecks ?? true),
    };
  return { requireReview: merging, requireChecks: merging };
}
