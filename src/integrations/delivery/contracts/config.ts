import type { DeliveryIntentView } from './views.js';
import type { DeliveryResultKind } from './vocabulary.js';

export interface ExternalDeliveryAdapter {
  deliver(intent: DeliveryIntentView, signal: AbortSignal): Promise<DeliveryResult>;
  reconcile(reconciliationKey: string, signal: AbortSignal): Promise<ReconciliationResult>;
}

export type DeliveryResult =
  | { readonly kind: typeof DeliveryResultKind.Confirmed; readonly externalId: string }
  | {
      readonly kind: typeof DeliveryResultKind.Failed;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: typeof DeliveryResultKind.Ambiguous; readonly reconciliationKey: string };

export type ReconciliationResult =
  | { readonly kind: typeof DeliveryResultKind.Confirmed; readonly externalId: string }
  | { readonly kind: typeof DeliveryResultKind.NotFound }
  | { readonly kind: typeof DeliveryResultKind.Unknown };
