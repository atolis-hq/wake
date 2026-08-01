const reportedUtcReset =
  /(?:resets?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(utc\)|utc)/i;
const reportedLocalReset = /(?:resets?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const fallbackPauseMs = 30 * 60_000;

/** Produces a durable deadline; an unlabelled provider clock is not trusted as UTC. */
export function resolveRunnerQuotaResumeAt(message: string, now: string): string {
  const current = new Date(now);
  const match = reportedUtcReset.exec(message);
  if (match === null) return localReset(message, current);
  let hour = Number(match[1]);
  if (hour === 12) hour = 0;
  if (match[3]?.toLowerCase() === 'pm') hour += 12;
  const reset = new Date(current);
  reset.setUTCHours(hour, Number(match[2] ?? 0), 0, 0);
  if (reset.getTime() <= current.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.toISOString();
}

function localReset(message: string, current: Date): string {
  const match = reportedLocalReset.exec(message);
  if (match === null) return new Date(current.getTime() + fallbackPauseMs).toISOString();
  let hour = Number(match[1]);
  if (hour === 12) hour = 0;
  if (match[3]?.toLowerCase() === 'pm') hour += 12;
  const reset = new Date(current);
  reset.setHours(hour, Number(match[2] ?? 0), 0, 0);
  if (reset.getTime() <= current.getTime()) reset.setDate(reset.getDate() + 1);
  return reset.toISOString();
}
