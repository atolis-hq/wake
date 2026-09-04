import type { EventId } from '@atolis-hq/eventing';
import type { EntityRef } from '../../kernel/index.js';
import type { AdapterId } from './identifiers.js';

export const IntegrationStreamKind = { Integration: 'integration', Delivery: 'delivery' } as const;

export type IntegrationStreamRef = EntityRef<typeof IntegrationStreamKind.Integration, AdapterId>;

export const integrationStream = (id: AdapterId): IntegrationStreamRef => ({
  kind: IntegrationStreamKind.Integration,
  id,
});

export const isIntegrationStream = (stream: EntityRef): stream is IntegrationStreamRef =>
  stream.kind === IntegrationStreamKind.Integration;

export type DeliveryStreamRef = EntityRef<typeof IntegrationStreamKind.Delivery, EventId>;

export const deliveryStream = (intentEventId: EventId): DeliveryStreamRef => ({
  kind: IntegrationStreamKind.Delivery,
  id: intentEventId,
});
