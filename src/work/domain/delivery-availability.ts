import type { WorkDelegation } from '../contracts/commands.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import { WorkStatus } from '../contracts/vocabulary.js';

export interface DeliveryWorkState {
  readonly state?: string;
  readonly frozen?: boolean;
  readonly deleted?: boolean;
  readonly delegation?: WorkDelegation;
}

export interface DeliveryAvailability {
  readonly rootWorkItemId: string;
  readonly reason?: string;
}

/** Ancestry comes from Work's validated creation facts, never descriptive links. */
export function deliveryAvailability(
  id: string,
  lookup: (id: WorkItemId) => DeliveryWorkState | null,
): DeliveryAvailability {
  const item = lookup(id as WorkItemId);
  const rootWorkItemId = item?.delegation?.rootWorkItemId ?? id;
  for (const [key, member] of [
    [id, item],
    ...(item?.delegation?.ancestors ?? []).map((ancestor) => [ancestor, lookup(ancestor)] as const),
  ] as const) {
    if (unavailable(member))
      return { rootWorkItemId, reason: `Delivery work ${key} is unavailable` };
  }
  return { rootWorkItemId };
}

function unavailable(member: DeliveryWorkState | null): boolean {
  return (
    member === null ||
    member.deleted === true ||
    member.frozen === true ||
    (member.state !== undefined && member.state !== WorkStatus.Open)
  );
}
