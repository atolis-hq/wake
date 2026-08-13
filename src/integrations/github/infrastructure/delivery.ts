import type { ExternalDeliveryAdapter } from '../../delivery/contracts/config.js';
import type { DeliveryIntentView } from '../../delivery/contracts/views.js';
import { DeliveryResultKind } from '../../delivery/contracts/vocabulary.js';

const GitHubDeliveryFailureCode = 'github-error';

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
          code: GitHubDeliveryFailureCode,
          message: githubErrorMessage(error),
        };
      }
    },
    async reconcile() {
      return { kind: DeliveryResultKind.Unknown };
    },
  };
}

function githubErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'GitHub delivery failed with a non-Error rejection';
}
