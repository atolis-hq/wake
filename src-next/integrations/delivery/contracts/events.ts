import { DeliveryResultKind } from './vocabulary.js';

export const DeliveryEventType = {
  AttemptStarted: 'delivery.attempt-started',
  Confirmed: 'delivery.confirmed',
  Failed: 'delivery.failed',
  Ambiguous: 'delivery.ambiguous',
  Reconciled: 'delivery.reconciled',
} as const;

export interface DeliveryEventPayloads {
  readonly [DeliveryEventType.AttemptStarted]: { readonly intentEventId: string };
  readonly [DeliveryEventType.Confirmed]: {
    readonly intentEventId: string;
    readonly externalId: string;
  };
  readonly [DeliveryEventType.Failed]: {
    readonly intentEventId: string;
    readonly code: string;
    readonly message: string;
  };
  readonly [DeliveryEventType.Ambiguous]: {
    readonly intentEventId: string;
    readonly reconciliationKey: string;
  };
  readonly [DeliveryEventType.Reconciled]: {
    readonly intentEventId: string;
    readonly result:
      | typeof DeliveryResultKind.Confirmed
      | typeof DeliveryResultKind.NotFound
      | typeof DeliveryResultKind.Unknown;
    readonly externalId?: string;
  };
}
