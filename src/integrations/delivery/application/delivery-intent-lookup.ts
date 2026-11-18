import type { ProjectionStore } from '@atolis-hq/eventing';
import { IntegrationStreamKind } from '../../contracts/streams.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind } from '../contracts/vocabulary.js';
import { deliveryProjectionKey } from './delivery-projector.js';

// A keyed read: the projection is keyed by intent id, so scanning every intent
// per lookup made each pending outcome cost O(all deliveries ever).
async function deliveryIntent(
  projections: ProjectionStore,
  intentEventId: string,
): Promise<DeliveryIntentView | undefined> {
  const stored = await projections.read<DeliveryIntentView | null>(
    IntegrationStreamKind.Delivery,
    deliveryProjectionKey(intentEventId),
  );
  return stored?.value?.intentEventId === intentEventId ? stored.value : undefined;
}

export async function isPublicationOnlyDelivery(
  projections: ProjectionStore,
  intentEventId: string,
): Promise<boolean> {
  const intent = await deliveryIntent(projections, intentEventId);
  return (
    intent !== undefined &&
    isReplyPublication(intent.payload) &&
    intent.payload.publicationOnly === true
  );
}

export async function conversationDeliveryIntent(
  projections: ProjectionStore,
  intentEventId: string,
) {
  const intent = await deliveryIntent(projections, intentEventId);
  if (
    intent === undefined ||
    !isAgentRunPublication(intent.payload) ||
    intent.payload.conversationId === undefined ||
    intent.payload.conversationEntryId === undefined
  )
    return undefined;
  return intent;
}

function isReplyPublication(
  payload: DeliveryIntentView['payload'],
): payload is Extract<
  DeliveryIntentView['payload'],
  { readonly kind: typeof DeliveryIntentKind.ReplyPublish }
> {
  return payload.kind === DeliveryIntentKind.ReplyPublish;
}

function isAgentRunPublication(
  payload: DeliveryIntentView['payload'],
): payload is Extract<
  DeliveryIntentView['payload'],
  { readonly kind: typeof DeliveryIntentKind.AgentRunPublish }
> {
  return payload.kind === DeliveryIntentKind.AgentRunPublish;
}
