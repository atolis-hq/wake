import { describe, expect, it } from 'vitest';

import { proposeReviewSignal } from '../../src-next/activities/index.js';

describe('proposeReviewSignal', () => {
  it('recognises an accepted command only when it occupies its own trimmed line', () => {
    expect(
      proposeReviewSignal({
        provider: 'github',
        resourceId: 'resource-github-owner-repo-1' as never,
        revision: 'a',
        actorId: 'human',
        providerEventId: 'event-1',
        body: 'Please review\n /accepted \nthanks',
      }),
    ).toMatchObject({ kind: 'accepted' });
    expect(
      proposeReviewSignal({
        provider: 'github',
        resourceId: 'resource-github-owner-repo-1' as never,
        revision: 'a',
        actorId: 'human',
        providerEventId: 'event-2',
        body: 'I think this is /accepted',
      }),
    ).toBeNull();
  });
});
