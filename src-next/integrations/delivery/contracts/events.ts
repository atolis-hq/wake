import type { EventEnvelope } from '../../../kernel/index.js';

export type DeliveryEvent = EventEnvelope<
  'integration.delivery-confirmed' | 'integration.delivery-failed',
  { readonly deliveryId: string }
>;
