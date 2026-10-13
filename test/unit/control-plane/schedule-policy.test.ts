import { describe, expect, it } from 'vitest';
import { CronTriggerPolicy } from '../../../src/control-plane/index.js';

const config: { id: string; workflow: string; cron: string } = {
  id: 'nightly',
  workflow: 'review',
  cron: '*/15 * * * *',
};

describe('CronTriggerPolicy', () => {
  it('inspects the next future UTC occurrence with the same day intersection as scheduling', () => {
    const policy = new CronTriggerPolicy();
    expect(policy.nextOccurrence('*/15 * * * *', '2026-07-31T12:15:00.000Z')).toBe(
      '2026-07-31T12:30:00.000Z',
    );
    expect(policy.nextOccurrence('0 0 1 * MON', '2026-05-01T00:00:00.000Z')).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
  it('uses one stable identity for each elapsed schedule slot', () => {
    const policy = new CronTriggerPolicy();

    expect(
      policy.elapsedSlots(config, '2026-07-31T12:31:00.000Z', '2026-07-31T12:00:00.000Z'),
    ).toEqual([
      {
        identity: 'trigger:nightly:cron:2026-07-31T12:15:00.000Z',
        at: '2026-07-31T12:15:00.000Z',
      },
      {
        identity: 'trigger:nightly:cron:2026-07-31T12:30:00.000Z',
        at: '2026-07-31T12:30:00.000Z',
      },
    ]);
  });

  it('does not fire a slot twice after restart', () => {
    const policy = new CronTriggerPolicy();

    expect(
      policy.elapsedSlots(config, '2026-07-31T12:31:00.000Z', '2026-07-31T12:30:00.000Z'),
    ).toEqual([]);
  });

  it('returns slots for ranges and named month and weekday fields', () => {
    const policy = new CronTriggerPolicy();
    const named = { ...config, cron: '0 9-10 * JAN MON' };

    expect(
      policy.elapsedSlots(named, '2026-01-05T10:01:00.000Z', '2026-01-05T08:59:00.000Z'),
    ).toEqual([
      {
        identity: 'trigger:nightly:cron:2026-01-05T09:00:00.000Z',
        at: '2026-01-05T09:00:00.000Z',
      },
      {
        identity: 'trigger:nightly:cron:2026-01-05T10:00:00.000Z',
        at: '2026-01-05T10:00:00.000Z',
      },
    ]);
  });

  it('rejects invalid syntax and expressions with a seconds field', () => {
    const policy = new CronTriggerPolicy();

    expect(() =>
      policy.elapsedSlots({ ...config, cron: '60 * * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toThrow();
    expect(() =>
      policy.elapsedSlots({ ...config, cron: '* * * * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toThrow('five-field cron expression');
  });

  it('evaluates expressions in UTC', () => {
    const policy = new CronTriggerPolicy();

    expect(
      policy.elapsedSlots({ ...config, cron: '0 0 * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toEqual([
      {
        identity: 'trigger:nightly:cron:2026-01-01T00:00:00.000Z',
        at: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('requires both day-of-month and day-of-week restrictions to match', () => {
    const policy = new CronTriggerPolicy();

    expect(
      policy.elapsedSlots(
        { ...config, cron: '0 0 1 * MON' },
        '2026-06-30T00:00:00.000Z',
        '2026-05-31T23:59:00.000Z',
      ),
    ).toEqual([
      {
        identity: 'trigger:nightly:cron:2026-06-01T00:00:00.000Z',
        at: '2026-06-01T00:00:00.000Z',
      },
    ]);
  });

  it('rejects undocumented randomized and extended cron syntax', () => {
    const policy = new CronTriggerPolicy();

    expect(() =>
      policy.elapsedSlots({ ...config, cron: 'H * * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toThrow();
    expect(() =>
      policy.elapsedSlots({ ...config, cron: '? * * * *' }, '2026-01-01T00:00:00.000Z', null),
    ).toThrow();
  });
});
