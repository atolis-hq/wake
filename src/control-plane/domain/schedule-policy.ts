import { CronExpressionParser } from 'cron-parser';
import type { ScheduleConfig } from '../contracts/config.js';

export interface ScheduleSlot {
  readonly identity: string;
  readonly at: string;
}

export class SchedulePolicy {
  elapsedSlots(
    config: ScheduleConfig,
    now: string,
    checkpoint: string | null,
  ): readonly ScheduleSlot[] {
    const end = minute(new Date(now));
    const start =
      checkpoint === null ? end : minute(new Date(new Date(checkpoint).getTime() + 60_000));
    if (start > end) return [];
    if (config.cron.trim().split(/\s+/).length !== 5)
      throw new Error(`Schedule ${config.id} must use a five-field cron expression`);
    const expression = CronExpressionParser.parse(config.cron, {
      currentDate: new Date(start - 1),
      endDate: new Date(end),
      tz: 'UTC',
    });
    const slots: ScheduleSlot[] = [];
    while (expression.hasNext()) {
      const at = expression.next().toDate().toISOString();
      slots.push({ identity: `schedule:${config.id}:${at}`, at });
    }
    return slots;
  }
}

function minute(value: Date): number {
  if (Number.isNaN(value.getTime())) throw new Error('Schedule timestamps must be valid dates');
  return Math.floor(value.getTime() / 60_000) * 60_000;
}
