import { describe, expect, it } from 'vitest';
import { MergeMethod } from '../../src-next/activities/index.js';
import { translateGitHubOutbound } from '../../src-next/integrations/github/application/outbound-translator.js';
import {
  BuiltInAdapterId,
  DeliveryIntentKind,
  DeliveryResultKind,
  DeliveryState,
} from '../../src-next/integrations/github/index.js';
import { createGitHubDelivery } from '../../src-next/integrations/github/infrastructure/delivery.js';
import { eventId } from '../../src-next/kernel/index.js';
import { BuiltInResourceKind } from '../../src-next/resources/index.js';
import { resId } from '../support/identities.js';

const mergeIntent = {
  intentEventId: eventId('intent'),
  globalPosition: 1,
  workflowInstanceId: 'workflow-1',
  activationId: 'activation-1',
  kind: DeliveryIntentKind.PrMerge,
  resourceId: resId('1'),
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
          resourceId: resId('1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r#2' },
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
          resourceId: resId('1'),
          kind: BuiltInResourceKind.PullRequest,
          externalKey: {
            adapter: BuiltInAdapterId.GitHub,
            key: 'o/r#9007199254740992',
          },
          capabilities: [],
        },
        mergeIntent,
      ),
    ).toThrow(/safe integer/i);
  });

  it('targets status publication at an observed issue rather than assuming a pull request', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resId('2'),
          kind: BuiltInResourceKind.Issue,
          externalKey: { adapter: BuiltInAdapterId.GitHub, key: 'o/r#3' },
          capabilities: [],
        },
        {
          ...mergeIntent,
          resourceId: resId('2'),
          kind: DeliveryIntentKind.StatusPublish,
          payload: { kind: DeliveryIntentKind.StatusPublish, body: 'Working' },
        },
      ),
    ).toMatchObject({ issue_number: 3, action: 'status' });
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
