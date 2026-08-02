import { describe, expect, it } from 'vitest';
import { SchedulePolicy, type ScheduleConfig } from '../../../src-next/control-plane/index.js';

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
});
