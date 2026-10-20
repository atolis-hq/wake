import { OrchestrationEventType } from '../contracts/events.js';
import type { WorkflowInstanceView } from '../contracts/views.js';
import { DelegationBlockerKind } from '../contracts/vocabulary.js';
import { contextBlockerId } from './delegation-attention-state.js';
import type { DelegationLedger } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';

/**
 * Children whose assignment-context blocker the parent escalated to a human and which are still
 * blocked on it. A human reply on the parent is routed to exactly these, so a published question
 * always has an answer path that moves the delivery without settling or joining the cohort.
 */
export async function escalatedTargets(
  repository: OrchestrationRepository,
  ledger: DelegationLedger,
  parent: WorkflowInstanceView,
): Promise<readonly { readonly childWorkItemId: string }[]> {
  const cohortId = parent.delegationWait?.cohortId;
  if (cohortId === undefined) return [];
  const { events } = await repository.history(parent.workflowInstanceId);
  const escalated = new Set(
    events.flatMap(({ event }) =>
      event.eventType === OrchestrationEventType.DelegationAttentionResolved &&
      event.payload.cohortId === cohortId &&
      event.payload.escalation !== undefined
        ? [event.payload.attentionKey]
        : [],
    ),
  );
  const reservation = (await ledger.reservations()).find(
    (entry) =>
      entry.parentWorkflowInstanceId === parent.workflowInstanceId && entry.cohortId === cohortId,
  );
  if (reservation === undefined || escalated.size === 0) return [];
  const targets = new Set<string>();
  const asked = events.flatMap(({ event }) =>
    event.eventType === OrchestrationEventType.DelegationAttentionRequested &&
    escalated.has(event.payload.attentionKey)
      ? event.payload.blockers.filter((blocker) => blocker.kind === DelegationBlockerKind.Context)
      : [],
  );
  for (const blocker of asked) {
    const child = reservation.children.find(
      (entry) => entry.workItemId === blocker.childWorkItemId,
    );
    if (child === undefined) continue;
    const view = (await repository.load(child.workflowInstanceId)).view;
    if (view !== null && contextBlockerId(child, view) === blocker.blockerId)
      targets.add(child.workItemId);
  }
  return [...targets].map((childWorkItemId) => ({ childWorkItemId }));
}
