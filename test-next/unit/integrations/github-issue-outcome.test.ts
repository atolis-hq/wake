import { describe, expect, it } from 'vitest';
import { issueObservation } from '../../../src-next/integrations/github/index.js';
import { ExternalWorkOutcome } from '../../../src-next/integrations/index.js';

describe('issueObservation outcome mapping', () => {
  it('has no outcome for an open issue', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 1,
        title: 'open issue',
        body: null,
        state: 'open',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(event.payload.outcome).toBeUndefined();
  });

  it('maps state_reason "completed" to ExternalWorkOutcome.Completed', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 2,
        title: 'done issue',
        body: null,
        state: 'closed',
        state_reason: 'completed',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(event.payload.outcome).toBe(ExternalWorkOutcome.Completed);
  });

  it('maps state_reason "not_planned" to ExternalWorkOutcome.Cancelled', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 3,
        title: 'wontfix issue',
        body: null,
        state: 'closed',
        state_reason: 'not_planned',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(event.payload.outcome).toBe(ExternalWorkOutcome.Cancelled);
  });

  it('treats a closed issue with no state_reason as Completed', () => {
    const event = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 4,
        title: 'legacy closed issue',
        body: null,
        state: 'closed',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(event.payload.outcome).toBe(ExternalWorkOutcome.Completed);
  });

  it('changes the eventId/revision fingerprint when only state_reason changes', () => {
    const completed = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 5,
        title: 'reclassified issue',
        body: null,
        state: 'closed',
        state_reason: 'completed',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    const notPlanned = issueObservation({
      repository: 'org/repo',
      issue: {
        number: 5,
        title: 'reclassified issue',
        body: null,
        state: 'closed',
        state_reason: 'not_planned',
        updated_at: '2026-08-05T00:00:00.000Z',
      },
    });
    expect(completed.eventId).not.toBe(notPlanned.eventId);
    expect(completed.payload.revision).not.toBe(notPlanned.payload.revision);
  });
});
