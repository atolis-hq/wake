import type { ExternalDeliveryAdapter } from '../../delivery/contracts/config.js';
import type { DeliveryIntentView } from '../../delivery/contracts/views.js';
import { DeliveryResultKind } from '../../delivery/contracts/vocabulary.js';

export function createGitHubDelivery(
  deliver: (intent: DeliveryIntentView, idempotencyKey: string) => Promise<string>,
): ExternalDeliveryAdapter {
  return {
    async deliver(intent) {
      try {
        return {
          kind: DeliveryResultKind.Confirmed,
          externalId: await deliver(intent, intent.intentEventId),
        };
      } catch (error) {
        return {
          kind: DeliveryResultKind.Failed,
          code: 'github-error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async reconcile() {
      return { kind: DeliveryResultKind.Unknown };
    },
  };
}
