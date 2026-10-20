import { expect, it } from 'vitest';
import { verifiedCheckSubject } from '../../../src/integrations/github/infrastructure/pr-check-subject.js';

it('uses the oldest execution start across every returned check and status, rather than poll time', () => {
  const result = verifiedCheckSubject(
    {
      available: true,
      complete: true,
      checkRuns: [{ started_at: '2026-10-20T00:05:00.000Z' }],
      statuses: [{ created_at: '2026-10-20T00:00:00.000Z' }],
    },
    'head',
    'base',
  );
  expect(result.checkEvidence).toEqual({
    headRevision: 'head',
    baseRevision: 'base',
    startedAt: '2026-10-20T00:00:00.000Z',
  });
});

it.each([
  { available: false, complete: false, checkRuns: [], statuses: [] },
  {
    available: true,
    complete: false,
    checkRuns: [{ started_at: '2026-10-20T00:05:00.000Z' }],
    statuses: [],
  },
  { available: true, complete: true, checkRuns: [], statuses: [] },
  { available: true, complete: true, checkRuns: [{}], statuses: [] },
  { available: true, complete: true, checkRuns: [{ started_at: 'invalid' }], statuses: [] },
])(
  'does not synthesize freshness from unavailable, truncated or undated evidence: %#',
  (evidence) => {
    expect(verifiedCheckSubject(evidence, 'head', 'base')).toEqual({});
  },
);
