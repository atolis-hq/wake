import { describe, expect, it } from 'vitest';
import { MergeMethod } from '../../src-next/activities/index.js';
import {
  BuiltInAdapterId,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
} from '../../src-next/integrations/index.js';
import { translateGitHubOutbound } from '../../src-next/integrations/github/application/outbound-translator.js';
import { createGitHubDelivery } from '../../src-next/integrations/github/infrastructure/delivery.js';
import { BuiltInResourceKind, resourceId } from '../../src-next/resources/index.js';

const mergeIntent = {
  intentEventId: 'intent',
  globalPosition: 1,
  workflowInstanceId: 'workflow-1',
  activationId: 'activation-1',
  kind: DeliveryIntentKind.PrMerge,
  resourceId: resourceId('resource-1'),
  payload: {
    kind: DeliveryIntentKind.PrMerge,
    revision: 'abc',
    method: MergeMethod.Squash,
  },
  state: DeliveryState.Pending,
  attempts: 0,
  occurrenceOrdinal: 0,
} as const;

describe('GitHub outbound delivery', () => {
  it('translates a provider-neutral merge without evaluating policy', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resourceId('resource-1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r/2' },
          capabilities: [],
        },
        mergeIntent,
      ),
    ).toMatchObject({ idempotencyKey: 'intent', merge_method: MergeMethod.Squash });
  });

  it('rejects a pull request number outside JavaScript safe integer bounds', () => {
    expect(() =>
      translateGitHubOutbound(
        {
          resourceId: resourceId('resource-1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: {
            adapter: BuiltInAdapterId.GitHub,
            key: 'o/r/9007199254740992',
          },
          capabilities: [],
        },
        mergeIntent,
      ),
    ).toThrow(/safe integer/i);
  });

  it('reports a stable message for a non-Error provider rejection', async () => {
    const adapter = createGitHubDelivery(async () => {
      throw { provider: 'github' };
    });

    await expect(adapter.deliver(mergeIntent, new AbortController().signal)).resolves.toEqual({
      kind: DeliveryResultKind.Failed,
      code: 'github-error',
      message: 'GitHub delivery failed with a non-Error rejection',
    });
  });
});
