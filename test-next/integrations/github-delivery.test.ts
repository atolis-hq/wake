import { describe, expect, it } from 'vitest';
import { translateGitHubOutbound } from '../../src-next/integrations/github/application/outbound-translator.js';
import { resourceId } from '../../src-next/resources/index.js';
describe('GitHub outbound delivery', () => {
  it('translates a provider-neutral merge without evaluating policy', () => {
    expect(
      translateGitHubOutbound(
        {
          resourceId: resourceId('resource-1'),
          kind: 'pull-request' as never,
          externalKey: { adapter: 'github', key: 'o/r/2' },
          capabilities: [],
        },
        {
          intentEventId: 'intent',
          globalPosition: 1,
          kind: 'pr.merge',
          resourceId: resourceId('resource-1'),
          payload: { kind: 'pr.merge', revision: 'abc', method: 'squash' },
          state: 'pending',
          attempts: 0,
        },
      ),
    ).toMatchObject({ action: 'merge', idempotencyKey: 'intent', merge_method: 'squash' });
  });
});
