import type { DelegationReservation } from '../contracts/delegation.js';
import { OrchestrationEventType, type WorkflowOrchestrationEvent } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import type { DeliveryFacts, Output } from '../domain/delivery-facts.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/**
 * Journal-derived facts for one parent delivery: its cohorts and their selected results, what each
 * child consumed, and the parent's own selection, candidate and QA facts.
 */
export async function readDeliveryFacts(
  repository: OrchestrationRepository,
  parent: WorkflowInstanceView,
  own: readonly WorkflowOrchestrationEvent[],
): Promise<DeliveryFacts> {
  const all = await repository.events();
  const reservations = distinctCohorts(
    all.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationReserved &&
      event.payload.parentWorkflowInstanceId === parent.workflowInstanceId
        ? [event.payload]
        : [],
    ),
  );
  const instances = new Map(
    reservations.flatMap((reservation) =>
      reservation.children.map((child) => [child.workflowInstanceId, child.workItemId] as const),
    ),
  );
  const results = all.flatMap(({ event }) =>
    event.eventType === OrchestrationEventType.DelegationResultSelected &&
    [...instances.values()].includes(event.payload.childWorkItemId)
      ? [event.payload]
      : [],
  );
  const consumed = new Map<string, Output[]>();
  for (const { event } of all) {
    if (event.eventType !== OrchestrationEventType.DelegationInputsResolved) continue;
    // Consumption receipts belong to the parent stream and identify their child in the payload.
    const child = event.payload.childWorkItemId;
    if (![...instances.values()].includes(child)) continue;
    consumed.set(child, [...(consumed.get(child) ?? []), ...event.payload.consumed]);
  }
  const mine = own.map(({ event }) => event);
  return {
    reservations,
    results,
    consumed,
    selections: mine.flatMap((event) =>
      event.eventType === OrchestrationEventType.DeliverySelectionRevised ? [event.payload] : [],
    ),
    candidates: mine.flatMap((event) =>
      event.eventType === OrchestrationEventType.DeliveryCandidateRecorded ? [event.payload] : [],
    ),
    qa: mine.flatMap((event) =>
      event.eventType === OrchestrationEventType.DeliveryQaRecorded ? [event.payload] : [],
    ),
    maintenance: mine.flatMap((event) =>
      event.eventType === OrchestrationEventType.DeliveryMaintenanceRecorded ? [event.payload] : [],
    ),
  };
}

function distinctCohorts(reservations: readonly DelegationReservation[]): DelegationReservation[] {
  const seen = new Set<string>();
  return reservations.filter((entry) => {
    const key = `${entry.parentWorkflowInstanceId}/${entry.cohortId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
