import { describe, expect, it } from 'vitest';

import { proposeReviewSignal } from '../../src-next/activities/index.js';

describe('proposeReviewSignal', () => {
  it('retains a provider-neutral canonical review decision', () => {
    expect(
      proposeReviewSignal({
        resourceId: 'resource-github-owner-repo-1' as never,
        revision: 'a',
        actorId: 'human',
        actorKind: 'human',
        resourceAuthorId: 'author',
        authorization: { source: 'configured-reviewer', reviewerId: 'human' },
        providerEventId: 'event-1',
        kind: 'accepted',
      }),
    ).toEqual({
      resourceId: 'resource-github-owner-repo-1',
      revision: 'a',
      actorId: 'human',
      actorKind: 'human',
      resourceAuthorId: 'author',
      kind: 'accepted',
      authorization: { source: 'configured-reviewer', reviewerId: 'human' },
      providerEventId: 'event-1',
    });
  });
});
