import type { DeliveryIntentView } from './views.js';

export interface DeliverNext {
  readonly signal: AbortSignal;
}

export interface DeliveryAttempt {
  readonly intent: DeliveryIntentView;
}
