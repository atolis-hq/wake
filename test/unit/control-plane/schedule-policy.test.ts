import { describe, expect, it } from 'vitest';
import { SchedulePolicy, type ScheduleConfig } from '../../../src/control-plane/index.js';

const config: ScheduleConfig = {
  id: 'nightly',
  workflow: 'review',
  cron: '*/15 * * * *',
  objective: 'Review the repository',
};

describe('SchedulePolicy', () => {
  it('uses one stable identity for each elapsed schedule slot', () => {
    const policy = new SchedulePolicy();

    expect(
      policy.elapsedSlots(config, '2026-07-31T12:31:00.000Z', '2026-07-31T12:00:00.000Z'),
    ).toEqual([
      {
        identity: 'schedule:nightly:2026-07-31T12:15:00.000Z',
        at: '2026-07-31T12:15:00.000Z',
      },
      {
        identity: 'schedule:nightly:2026-07-31T12:30:00.000Z',
        at: '2026-07-31T12:30:00.000Z',
      },
    ]);
  });

  it('does not fire a slot twice after restart', () => {
    const policy = new SchedulePolicy();

    expect(
      policy.elapsedSlots(config, '2026-07-31T12:31:00.000Z', '2026-07-31T12:30:00.000Z'),
    ).toEqual([]);
  });

  it('returns slots for ranges and named month and weekday fields', () => {
    const policy = new SchedulePolicy();
    const named = { ...config, cron: '0 9-10 * JAN MON' };

    expect(
      policy.elapsedSlots(named, '2026-01-05T10:01:00.000Z', '2026-01-05T08:59:00.000Z'),
    ).toEqual([
      {
        identity: 'schedule:nightly:2026-01-05T09:00:00.000Z',
        at: '2026-01-05T09:00:00.000Z',
      },
      {
        identity: 'schedule:nightly:2026-01-05T10:00:00.000Z',
        at: '2026-01-05T10:00:00.000Z',
      },
    ]);
  });

  it('rejects invalid syntax and expressions with a seconds field', () => {
    const policy = new SchedulePolicy();

    expect(() =>
      policy.elapsedSlots({ ...config, cron: '60 * * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toThrow();
    expect(() =>
      policy.elapsedSlots({ ...config, cron: '* * * * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toThrow('five-field cron expression');
  });

  it('evaluates expressions in UTC', () => {
    const policy = new SchedulePolicy();

    expect(
      policy.elapsedSlots({ ...config, cron: '0 0 * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toEqual([
      {
        identity: 'schedule:nightly:2026-01-01T00:00:00.000Z',
        at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });
});
