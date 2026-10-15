import { BuiltInActivityName } from '../../../activities/index.js';
import type { ExternalDeliveryAdapter } from '../../delivery/contracts/config.js';
import type { DeliveryIntentView } from '../../delivery/contracts/views.js';
import { DeliveryResultKind } from '../../delivery/contracts/vocabulary.js';

const GitHubDeliveryFailureCode = 'github-error';

export function createGitHubDelivery(
  deliver: (intent: DeliveryIntentView, idempotencyKey: string) => Promise<string>,
  reconcileIssue?: (intent: DeliveryIntentView) => Promise<string | null>,
  precondition?: (
    intent: DeliveryIntentView,
  ) => Promise<{ readonly allowed: boolean; readonly reason?: string }>,
  mergedTarget?: (intent: DeliveryIntentView) => Promise<string | null>,
): ExternalDeliveryAdapter {
  async function confirmedMerge(intent: DeliveryIntentView) {
    if (intent.kind !== BuiltInActivityName.PullRequestMerge) return null;
    const externalId = await mergedTarget?.(intent);
    return externalId == null ? null : { kind: DeliveryResultKind.Confirmed, externalId };
  }

  return {
    async deliver(intent) {
      try {
        const merged = await confirmedMerge(intent);
        if (merged !== null) return merged;
        if (
          intent.kind === BuiltInActivityName.PullRequestMerge &&
          'autoMerge' in intent.payload &&
          intent.payload.autoMerge
        ) {
          const result = await precondition?.(intent);
          if (result !== undefined && !result.allowed)
            throw new Error(result.reason ?? 'auto-merge precondition failed');
        }
        return {
          kind: DeliveryResultKind.Confirmed,
          externalId: await deliver(intent, intent.intentEventId),
        };
      } catch (error) {
        try {
          const merged = await confirmedMerge(intent);
          if (merged !== null) return merged;
        } catch {
          // Unavailable evidence cannot turn a failed attempt into success.
        }
        return {
          kind: DeliveryResultKind.Failed,
          code: GitHubDeliveryFailureCode,
          message: githubErrorMessage(error),
        };
      }
    },
    async reconcile(intent) {
      if (intent.kind === BuiltInActivityName.PullRequestMerge) {
        try {
          return (await confirmedMerge(intent)) ?? { kind: DeliveryResultKind.Unknown };
        } catch {
          return { kind: DeliveryResultKind.Unknown };
        }
      }
      if (intent.kind !== BuiltInActivityName.IssueComplete || reconcileIssue === undefined)
        return { kind: DeliveryResultKind.Unknown };
      try {
        const externalId = await reconcileIssue(intent);
        return externalId === null
          ? { kind: DeliveryResultKind.NotFound }
          : { kind: DeliveryResultKind.Confirmed, externalId };
      } catch {
        return { kind: DeliveryResultKind.Unknown };
      }
    },
  };
}

function githubErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'GitHub delivery failed with a non-Error rejection';
}
