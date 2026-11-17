import type { DelegationInputs } from '../contracts/delegation.js';
import { OrchestrationEventType, type WorkflowOrchestrationEvent } from '../contracts/events.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/** The latest journaled consumption receipt for a delegated child. */
export function latestDelegationInputs(
  events: readonly WorkflowOrchestrationEvent[],
  childWorkItemId: string,
): DelegationInputs | undefined {
  return events
    .flatMap(({ event }) =>
      (event.eventType === OrchestrationEventType.DelegationInputsResolved ||
        event.eventType === OrchestrationEventType.DelegationInputsRefreshed) &&
      event.payload.childWorkItemId === childWorkItemId
        ? [event.payload]
        : [],
    )
    .at(-1);
}

/** Read-only receipt lookup for integrations that verify stacked child outputs. */
export function createDelegationInputsReader(repository: OrchestrationRepository) {
  return async (childWorkItemId: string) =>
    latestDelegationInputs(await repository.events(), childWorkItemId);
}
