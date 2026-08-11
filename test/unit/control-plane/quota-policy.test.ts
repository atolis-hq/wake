import { expect, it } from 'vitest';
import { QuotaPolicy } from '../../../src/control-plane/index.js';

it('persists a quota pause deadline and resumes only when the clock reaches it', () => {
  const policy = new QuotaPolicy({ maxDispatches: 2, pauseDurationMs: 5 * 60_000 });

  expect(policy.decide('2026-07-31T12:00:00.000Z', 2, null)).toEqual({
    kind: 'pause',
    resumeAt: '2026-07-31T12:05:00.000Z',
    reason: 'dispatch quota exhausted',
  });
  expect(policy.decide('2026-07-31T12:01:00.000Z', 0, '2026-07-31T12:05:00.000Z')).toEqual({
    kind: 'paused',
    resumeAt: '2026-07-31T12:05:00.000Z',
  });
  expect(policy.decide('2026-07-31T12:05:00.000Z', 0, '2026-07-31T12:05:00.000Z')).toEqual({
    kind: 'resume',
  });
});
