import { expect, it } from 'vitest';
import { resolveRunnerQuotaResumeAt } from '../../../src/control-plane/index.js';

it('uses an explicit UTC runner reset time and otherwise waits thirty minutes', () => {
  expect(
    resolveRunnerQuotaResumeAt(
      "You've hit your session limit - resets 1:10am (UTC)",
      '2026-08-01T22:30:00.000Z',
    ),
  ).toBe('2026-08-02T01:10:00.000Z');
  expect(resolveRunnerQuotaResumeAt('quota exhausted', '2026-08-01T22:30:00.000Z')).toBe(
    '2026-08-01T23:00:00.000Z',
  );
});

it('converts an unzoned runner reset clock using the local machine timezone', () => {
  const now = new Date('2026-08-01T22:30:00.000Z');
  const expected = new Date(now);
  expected.setHours(14, 29, 0, 0);
  if (expected.getTime() <= now.getTime()) expected.setDate(expected.getDate() + 1);
  expect(
    resolveRunnerQuotaResumeAt(
      "You've hit your usage limit. Try again at 2:29 PM.",
      now.toISOString(),
    ),
  ).toBe(expected.toISOString());
});
