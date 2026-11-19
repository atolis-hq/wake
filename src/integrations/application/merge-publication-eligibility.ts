import type { EventJournal } from '@atolis-hq/eventing';
import {
  activityDecisionStream,
  ActivityEventType,
  MergeMethod,
  PullRequestState,
  selectActivityEvent,
} from '../../activities/index.js';
import type { WorkflowInstanceView } from '../../orchestration/index.js';
import { resourceId, resourceStream } from '../../resources/index.js';
import type { DeliveryIntentView } from '../delivery/contracts/views.js';
import { isMergePublicationWait } from './agent-run-publication-report.js';

/** Pin the actual merge decision's subject, independently of reply routing. */
export async function awaitedMergeResource(
  journal: EventJournal,
  workflow: WorkflowInstanceView,
): Promise<string | undefined> {
  if (!isMergePublicationWait(workflow)) return undefined;
  const facts = await journal.readStream(
    activityDecisionStream(workflow.pendingActivation.activationId, MergeMethod.Merge),
  );
  for (const fact of facts) {
    const decision = selectActivityEvent(fact);
    if (decision?.event.eventType === ActivityEventType.PrMergeDecisionClaimed)
      return decision.event.payload.fact.payload.resourceId ?? undefined;
  }
  return undefined;
}

export async function hasAwaitedMergeEvidence(
  journal: EventJournal,
  intent: DeliveryIntentView,
): Promise<boolean> {
  if (intent.awaitingMergeResourceId === undefined) return false;
  const facts = await journal.readStream(
    resourceStream(resourceId(intent.awaitingMergeResourceId)),
  );
  return facts.some((fact) => {
    const activity = selectActivityEvent(fact);
    return (
      (activity?.event.eventType === ActivityEventType.PrStateChanged ||
        activity?.event.eventType === ActivityEventType.PrDiscovered) &&
      activity.event.payload.state === PullRequestState.Merged
    );
  });
}
