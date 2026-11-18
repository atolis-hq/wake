import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind, DeliveryState } from '../contracts/vocabulary.js';

// Gating intents decide when a workflow can move on; comments only report on it.
// A merge must not wait behind a backlog of status publications.
function deliveryUrgency(kind: DeliveryIntentView['kind']): number {
  return kind === DeliveryIntentKind.PrMerge ||
    kind === DeliveryIntentKind.PrApprove ||
    kind === DeliveryIntentKind.IssueComplete
    ? 0
    : 1;
}

export function nextDeliverable(
  intents: readonly DeliveryIntentView[],
  skip: ReadonlySet<string> | undefined,
): DeliveryIntentView | undefined {
  let best: DeliveryIntentView | undefined;
  for (const item of intents) {
    if (
      (item.state !== DeliveryState.Pending && item.state !== DeliveryState.Ambiguous) ||
      item.escalation !== undefined ||
      skip?.has(item.intentEventId) === true
    )
      continue;
    if (
      best === undefined ||
      deliveryUrgency(item.kind) < deliveryUrgency(best.kind) ||
      (deliveryUrgency(item.kind) === deliveryUrgency(best.kind) &&
        item.globalPosition < best.globalPosition)
    )
      best = item;
  }
  return best;
}
