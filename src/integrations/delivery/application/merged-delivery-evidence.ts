import {
  EventActorKind,
  EventSourceKind,
  type EventJournal,
  type ProjectionStore,
} from '@atolis-hq/eventing';
import {
  ActivityEventType,
  PullRequestState,
  selectPrimaryPullRequest,
  type PullRequestService,
} from '../../../activities/index.js';
import {
  ActivityActivationStatus,
  workflowInstanceId,
  type OrchestrationService,
} from '../../../orchestration/index.js';
import { deliveryStream, IntegrationStreamKind } from '../../contracts/streams.js';
import { createDeliveryEventData } from '../contracts/event-factory.js';
import { DeliveryEventType, selectDeliveryEvent } from '../contracts/events.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind, DeliveryResultKind, DeliveryState } from '../contracts/vocabulary.js';

export async function reconcileMergedDeliveries(input: {
  readonly journal: EventJournal;
  readonly projections: ProjectionStore;
  readonly orchestration: Pick<OrchestrationService, 'get'>;
  readonly pullRequests: PullRequestService;
}): Promise<void> {
  for (const entry of await input.projections.list<DeliveryIntentView>(
    IntegrationStreamKind.Delivery,
  )) {
    await confirmMergedDelivery(
      entry.value,
      input.journal,
      input.orchestration,
      input.pullRequests,
    );
  }
}

/** Reconcile durable merged evidence only after the exact intent's wait exists. */
export async function confirmMergedDelivery(
  intent: DeliveryIntentView,
  journal: EventJournal,
  orchestration: Pick<OrchestrationService, 'get'>,
  pullRequests: PullRequestService,
): Promise<void> {
  if (
    intent.payload.kind !== DeliveryIntentKind.PrMerge ||
    !('revision' in intent.payload) ||
    (intent.state !== DeliveryState.Pending && intent.state !== DeliveryState.Ambiguous)
  )
    return;
  const instance = await orchestration.get(workflowInstanceId(intent.workflowInstanceId));
  if (!isMatchingWait(instance, intent)) return;
  const selected = selectPrimaryPullRequest(
    await pullRequests.authorityInput(instance.workItemId),
    instance.workItemId,
  );
  if (
    selected?.pullRequest.resourceId !== intent.resourceId ||
    selected.pullRequest.state !== PullRequestState.Merged ||
    selected.pullRequest.headRevision !== intent.payload.revision
  )
    return;
  const evidence = (await pullRequests.factsFor(intent.resourceId)).find(
    (fact) =>
      fact.event.eventType === ActivityEventType.PrStateChanged &&
      fact.event.payload.state === PullRequestState.Merged,
  );
  if (evidence === undefined) return;
  const stream = deliveryStream(intent.intentEventId);
  const facts = await journal.readStream(stream);
  if (
    facts.some((fact) => {
      const delivery = selectDeliveryEvent(fact);
      return (
        delivery?.event.eventType === DeliveryEventType.Failed ||
        delivery?.event.eventType === DeliveryEventType.Confirmed ||
        (delivery?.event.eventType === DeliveryEventType.Reconciled &&
          delivery.event.payload.result === DeliveryResultKind.Confirmed)
      );
    })
  )
    return;
  await journal.appendToStream(stream, facts.length, [
    createDeliveryEventData({
      eventId: `${intent.intentEventId}:merged-evidence`,
      eventType: DeliveryEventType.Reconciled,
      occurredAt: evidence.event.occurredAt,
      correlationId: evidence.event.correlationId,
      causationId: evidence.event.eventId,
      actor: { kind: EventActorKind.System, id: 'delivery-outcome-reactor' },
      source: { kind: EventSourceKind.Internal, id: IntegrationStreamKind.Delivery },
      payload: {
        intentEventId: intent.intentEventId,
        intentGlobalPosition: intent.globalPosition,
        workflowInstanceId: intent.workflowInstanceId,
        activationId: intent.activationId,
        occurrenceOrdinal: intent.occurrenceOrdinal + 1,
        result: DeliveryResultKind.Confirmed,
        externalId: selected.resource.resource.externalKey.key,
      },
    }),
  ]);
}

function isMatchingWait(
  instance: Awaited<ReturnType<OrchestrationService['get']>>,
  intent: DeliveryIntentView,
): instance is NonNullable<Awaited<ReturnType<OrchestrationService['get']>>> {
  return (
    instance?.pendingActivation?.activationId === intent.activationId &&
    instance.pendingActivation.status === ActivityActivationStatus.Waiting &&
    instance.waitingFor?.signalKind === 'delivery-result' &&
    instance.waitingFor.intentEventId === intent.intentEventId
  );
}
