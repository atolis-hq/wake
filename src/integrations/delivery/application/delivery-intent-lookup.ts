import type { ProjectionStore } from '@atolis-hq/eventing';
import { IntegrationStreamKind } from '../../contracts/streams.js';
import type { DeliveryIntentView } from '../contracts/views.js';
import { DeliveryIntentKind } from '../contracts/vocabulary.js';

export async function isPublicationOnlyDelivery(
  projections: ProjectionStore,
  intentEventId: string,
): Promise<boolean> {
  const intent = (await projections.list<DeliveryIntentView>(IntegrationStreamKind.Delivery)).find(
    (entry) => entry.value.intentEventId === intentEventId,
  )?.value;
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
  const intent = (await projections.list<DeliveryIntentView>(IntegrationStreamKind.Delivery)).find(
    (candidate) => candidate.value.intentEventId === intentEventId,
  )?.value;
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
