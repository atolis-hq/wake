import { describe, expect, it } from 'vitest';

import { resolveQuotaPauseUntil } from '../../src/core/quota-backoff.js';

describe('quota backoff', () => {
  it('uses the next UTC reset time reported by the runner', () => {
    const now = new Date('2026-07-07T22:30:00.000Z');

    expect(
      resolveQuotaPauseUntil({
        result: "You've hit your session limit - resets 1:10am (UTC)",
        now,
        failureCount: 1,
      }),
    ).toEqual({ pausedUntil: '2026-07-08T01:10:00.000Z', source: 'reported' });
  });

  it('uses bounded exponential fallback when no reset time is reported', () => {
    const now = new Date('2026-07-07T22:30:00.000Z');

    expect(resolveQuotaPauseUntil({ result: 'Quota exhausted', now, failureCount: 3 })).toEqual({
      pausedUntil: '2026-07-07T23:30:00.000Z',
      source: 'estimated',
    });
  });

  it('caps the exponential fallback at 1 hour even for many consecutive failures', () => {
    const now = new Date('2026-07-07T22:30:00.000Z');

    expect(resolveQuotaPauseUntil({ result: 'Quota exhausted', now, failureCount: 6 })).toEqual({
      pausedUntil: '2026-07-07T23:30:00.000Z',
      source: 'estimated',
    });
  });

  it('treats an unlabeled reset time as this machine local time, not UTC', () => {
    const now = new Date('2026-07-07T22:30:00.000Z');
    const localReset = new Date(now);
    localReset.setHours(14, 29, 0, 0);
    if (localReset.getTime() <= now.getTime()) {
      localReset.setDate(localReset.getDate() + 1);
    }

    expect(
      resolveQuotaPauseUntil({
        result: "You've hit your usage limit. Upgrade to Pro or try again at 2:29 PM.",
        now,
        failureCount: 1,
      }),
    ).toEqual({ pausedUntil: localReset.toISOString(), source: 'reported' });
  });
});
