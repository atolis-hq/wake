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
    const fields = config.cron.trim().split(/\s+/);
    if (fields.length !== 5)
      throw new Error(`Schedule ${config.id} must use a five-field cron expression`);
    if (fields.some(hasUnsupportedSyntax))
      throw new Error(`Schedule ${config.id} uses unsupported cron syntax`);
    const expression = CronExpressionParser.parse(config.cron, {
      currentDate: new Date(start - 1),
      endDate: new Date(end),
      tz: 'UTC',
    });
    const dayOfMonth = fieldExpression(fields, 2, 4);
    const dayOfWeek = fieldExpression(fields, 4, 2);
    const slots: ScheduleSlot[] = [];
    while (expression.hasNext()) {
      const date = expression.next().toDate();
      if (!matchesDays(date, dayOfMonth, dayOfWeek)) continue;
      const at = date.toISOString();
      slots.push({ identity: `schedule:${config.id}:${at}`, at });
    }
    return slots;
  }
}

function minute(value: Date): number {
  if (Number.isNaN(value.getTime())) throw new Error('Schedule timestamps must be valid dates');
  return Math.floor(value.getTime() / 60_000) * 60_000;
}

function hasUnsupportedSyntax(field: string): boolean {
  return /[?#]|(^|[,*\/-])H(?=$|[,*\/-])|(^|[,*\/-])L(?=$|[,*\/-])|\dL\b/i.test(field);
}

function fieldExpression(fields: readonly string[], index: number, wildcardIndex: number) {
  if (fields[index] === '*') return null;
  const constrained = [...fields];
  constrained[wildcardIndex] = '*';
  return CronExpressionParser.parse(constrained.join(' '), { tz: 'UTC' });
}

function matchesDays(
  date: Date,
  dayOfMonth: ReturnType<typeof fieldExpression>,
  dayOfWeek: ReturnType<typeof fieldExpression>,
): boolean {
  return (dayOfMonth?.includesDate(date) ?? true) && (dayOfWeek?.includesDate(date) ?? true);
}
