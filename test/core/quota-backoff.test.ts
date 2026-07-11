import { describe, expect, it } from 'vitest';

import { resolveQuotaPauseUntil } from '../../src/core/quota-backoff.js';

describe('quota backoff', () => {
  it('uses the next UTC reset time reported by the runner', () => {
    const now = new Date('2026-07-07T22:30:00.000Z');

    expect(resolveQuotaPauseUntil({
      result: "You've hit your session limit - resets 1:10am (UTC)",
      now,
      failureCount: 1,
    })).toBe('2026-07-08T01:10:00.000Z');
  });

  it('uses bounded exponential fallback when no reset time is reported', () => {
    const now = new Date('2026-07-07T22:30:00.000Z');

    expect(resolveQuotaPauseUntil({ result: 'Quota exhausted', now, failureCount: 3 }))
      .toBe('2026-07-07T23:30:00.000Z');
  });
});
