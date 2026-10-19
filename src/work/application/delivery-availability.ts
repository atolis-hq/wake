import type { WorkDelegation } from '../contracts/commands.js';
import type { WorkItemId } from '../contracts/identifiers.js';
import { WorkStatus } from '../contracts/vocabulary.js';

export interface DeliveryWorkState {
  readonly state?: string;
  readonly frozen?: boolean;
  readonly deleted?: boolean;
  readonly delegation?: WorkDelegation;
}

/** Ancestry comes from Work's validated creation facts, never descriptive links. */
export async function readDeliveryAvailability(
  id: string,
  work: {
    get(id: WorkItemId, options?: { readonly fresh?: boolean }): Promise<DeliveryWorkState | null>;
  },
): Promise<{ readonly rootWorkItemId: string; readonly reason?: string }> {
  const item = await work.get(id as WorkItemId, { fresh: true });
  const rootWorkItemId = item?.delegation?.rootWorkItemId ?? id;
  for (const [key, member] of [
    [id, item],
    ...(await Promise.all(
      (item?.delegation?.ancestors ?? []).map(
        async (ancestor) => [ancestor, await work.get(ancestor, { fresh: true })] as const,
      ),
    )),
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
