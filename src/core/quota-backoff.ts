export function resolveQuotaPauseUntil(input: {
  result: string;
  now: Date;
  failureCount: number;
}): string {
  const resetTime = /resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(UTC\)|UTC)/i.exec(
    input.result,
  );
  if (resetTime !== null) {
    let hours = Number(resetTime[1]);
    const minutes = Number(resetTime[2] ?? 0);
    const meridiem = resetTime[3]?.toLowerCase();
    if (hours === 12) {
      hours = 0;
    }
    if (meridiem === 'pm') {
      hours += 12;
    }

    const reset = new Date(input.now);
    reset.setUTCHours(hours, minutes, 0, 0);
    if (reset.getTime() <= input.now.getTime()) {
      reset.setUTCDate(reset.getUTCDate() + 1);
    }
    return reset.toISOString();
  }

  const boundedFailureCount = Math.max(1, Math.min(input.failureCount, 6));
  const delayMs = Math.min(15 * 60_000 * (2 ** (boundedFailureCount - 1)), 8 * 60 * 60_000);
  return new Date(input.now.getTime() + delayMs).toISOString();
}
