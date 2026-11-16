import type { CommandContext } from '@atolis-hq/eventing';
import type { ChildWorkflowRequest } from '../contracts/events.js';
import { OrchestrationEventType as Event } from '../contracts/events.js';
import { WorkflowStatus } from '../contracts/vocabulary.js';
import { DelegationLedger, reservationsOf } from './delegation-ledger.js';
import type { OrchestrationRepository } from './orchestration-repository.js';
import { currentReviewRefreshes } from './review-refresh-facts.js';

/** Recover committed requests independently; one unavailable child must not stall other work. */
export async function reconcileReviewRefreshes(
  repository: OrchestrationRepository,
  execute: (
    request: ChildWorkflowRequest & { maxPerGroup: number },
    context: CommandContext,
  ) => Promise<unknown>,
  context: CommandContext,
) {
  const facts = await repository.events();
  for (const { id, triggerId, request } of currentReviewRefreshes(facts).values()) {
    const parent = (await repository.loadRequired(id)).view;
    if (parent.status !== WorkflowStatus.Completed) continue;
    try {
      await execute(
        {
          parentWorkflowInstanceId: id,
          watchId: request.watchId,
          triggerId,
          workflowName: request.workflowName,
          requestId: request.requestId,
          causalCycleId: request.requestId,
          maxPerGroup: request.maxPerGroup,
        },
        context,
      );
    } catch (error) {
      const owner = reservationsOf(facts).find((reservation) =>
        reservation.children.some((child) => child.workflowInstanceId === id),
      );
      if (owner === undefined) throw error;
      await new DelegationLedger(repository).appendOnce(
        owner.parentWorkflowInstanceId,
        context,
        `review-refresh-unavailable:${request.requestId}`,
        {
          eventType: Event.DelegationReconciliationFailed,
          payload: {
            cohortId: owner.cohortId,
            reason:
              'Review refresh unavailable: ' +
              (error instanceof Error ? error.message : 'unknown error'),
          },
        },
      );
    }
  }
}
