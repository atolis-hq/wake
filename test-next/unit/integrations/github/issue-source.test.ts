import { describe, expect, it } from 'vitest';
import { issueCommentObservation } from '../../../../src-next/integrations/github/infrastructure/issue-source.js';

describe('issueCommentObservation', () => {
  it('captures a comment whose body is not /approved', () => {
    const event = issueCommentObservation({
      repository: 'atolis-hq/wake-test',
      issue: { number: 7 },
      comment: {
        id: 99,
        body: 'This needs another pass on error handling.',
        created_at: '2026-08-08T00:00:00Z',
        updated_at: '2026-08-08T00:00:00Z',
        user: { login: 'a-reviewer', type: 'User' },
      },
    });

    expect(event).not.toBeNull();
    expect(event?.payload.body).toBe('This needs another pass on error handling.');
  });

  it('still captures /approved, unchanged', () => {
    const event = issueCommentObservation({
      repository: 'atolis-hq/wake-test',
      issue: { number: 7 },
      comment: {
        id: 100,
        body: '/approved',
        created_at: '2026-08-08T00:00:00Z',
        updated_at: '2026-08-08T00:00:00Z',
        user: { login: 'owner', type: 'User' },
      },
    });

    expect(event?.payload.body).toBe('/approved');
  });

  it('drops a comment with an empty body', () => {
    const event = issueCommentObservation({
      repository: 'atolis-hq/wake-test',
      issue: { number: 7 },
      comment: {
        id: 101,
        body: '   ',
        created_at: '2026-08-08T00:00:00Z',
        updated_at: '2026-08-08T00:00:00Z',
        user: { login: 'owner', type: 'User' },
      },
    });

    expect(event).toBeNull();
  });
});
