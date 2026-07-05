import { describe, expect, it } from 'vitest';

import { createFakeWorkSource } from '../../src/adapters/fake/fake-work-source.js';

describe('fake work source', () => {
  it('marks wake-authored comments using the wake marker', async () => {
    const source = createFakeWorkSource({
      issues: [
        {
          repo: 'atolis-hq/wake',
          number: 3,
          title: 'Blocked item',
          body: 'Needs detail',
          labels: ['wake:blocked'],
          comments: [
            { id: 'c1', body: 'Question <!-- wake -->', author: { login: 'shared-user' } },
            { id: 'c2', body: 'Here is the answer', author: { login: 'shared-user' } },
          ],
        },
      ],
    });

    const items = await source.syncIssues();
    expect(items[0]?.comments.at(-1)?.isWakeAuthored).toBe(false);
  });
});
