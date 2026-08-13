import { expect, it } from 'vitest';
import { SchedulePolicy } from '../../../src/control-plane/index.js';

const scenario = { id: 'E2E-SCHEDULE-001' } as const;

it(`${scenario.id}: restart across an elapsed slot keeps one stable slot identity`, () => {
  const policy = new SchedulePolicy();
  const config = { id: 'hourly', workflow: 'review', cron: '* * * * *', objective: 'Review' };
  const first = policy.elapsedSlots(config, '2026-07-31T12:01:00.000Z', '2026-07-31T12:00:00.000Z');
  const restarted = policy.elapsedSlots(
    config,
    '2026-07-31T12:01:00.000Z',
    '2026-07-31T12:01:00.000Z',
  );
  expect(first).toHaveLength(1);
  expect(restarted).toEqual([]);
  expect(first[0]?.identity).toBe('schedule:hourly:2026-07-31T12:01:00.000Z');
});
