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
    const fields = config.cron.trim().split(/\s+/);
    if (fields.length !== 5)
      throw new Error(`Schedule ${config.id} must use a five-field cron expression`);
    const slots: ScheduleSlot[] = [];
    for (let cursor = start; cursor <= end; cursor += 60_000) {
      const date = new Date(cursor);
      if (matches(fields, date)) {
        const at = date.toISOString();
        slots.push({ identity: `schedule:${config.id}:${at}`, at });
      }
    }
    return slots;
  }
}

function minute(value: Date): number {
  if (Number.isNaN(value.getTime())) throw new Error('Schedule timestamps must be valid dates');
  return Math.floor(value.getTime() / 60_000) * 60_000;
}

function matches(fields: readonly string[], date: Date): boolean {
  return (
    matchesField(fields[0]!, date.getUTCMinutes(), 0, 59) &&
    matchesField(fields[1]!, date.getUTCHours(), 0, 23) &&
    matchesField(fields[2]!, date.getUTCDate(), 1, 31) &&
    matchesField(fields[3]!, date.getUTCMonth() + 1, 1, 12) &&
    matchesField(fields[4]!, date.getUTCDay(), 0, 6)
  );
}

function matchesField(
  expression: string,
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return expression.split(',').some((part) => {
    const [base, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${part}`);
    if (base === '*') return (value - minimum) % step === 0;
    const number = Number(base);
    if (!Number.isInteger(number) || number < minimum || number > maximum)
      throw new Error(`Invalid cron field: ${part}`);
    return value === number;
  });
}
