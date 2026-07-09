import { describe, expect, it } from 'vitest';

import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';

describe('fake ticketing system', () => {
  it('emits issue and comment events with shared work item correlation', async () => {
    const source = createFakeTicketingSystem({
      tickets: [
        {
          repo: 'atolis-hq/wake',
          number: 3,
          title: 'Blocked item',
          body: 'Needs detail',
          labels: ['wake:blocked'],
          comments: [
            { id: 'c1', body: 'Question', author: { login: 'shared-user' } },
            { id: 'c2', body: 'Here is the answer', author: { login: 'shared-user' } },
          ],
        },
      ],
      now: () => new Date('2026-07-05T12:00:00.000Z'),
    });

    const events = await source.pollEvents();
    const issueEvent = events.find((event) => event.sourceEventType === 'fake.issue.upsert');
    const commentEvents = events.filter((event) => event.sourceEventType === 'fake.issue.comment.created');

    expect(issueEvent?.workItemKey).toBe('atolis-hq/wake#3');
    expect(commentEvents).toHaveLength(2);
    expect(commentEvents[0]?.workItemKey).toBe('atolis-hq/wake#3');
    expect(commentEvents[1]?.derivedHints?.botAuthoredComment).toBe(false);
  });
});
