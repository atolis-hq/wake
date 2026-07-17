import { describe, expect, it } from 'vitest';

import { createFakeTicketingSystem } from '../../src/adapters/fake/fake-ticketing-system.js';

describe('fake ticketing system', () => {
  it('emits unkeyed issue and comment events carrying a resourceUri, never a workItemKey', async () => {
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

    // Sources do not self-key (spec D1): the resolver in tick-runner stamps
    // the canonical workItemKey between poll and append. Every event carries
    // the resourceUri it came from so the resolver has something to resolve.
    for (const event of events) {
      expect(event).not.toHaveProperty('workItemKey');
      expect(event.sourceRefs.resourceUri).toBe('fake-ticketing:issue:atolis-hq/wake#3');
    }

    expect(issueEvent).toBeDefined();
    expect(commentEvents).toHaveLength(2);
    expect(commentEvents[1]?.derivedHints?.botAuthoredComment).toBe(false);
  });
});
