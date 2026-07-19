function applyTimeOfDay(input: {
  hours: number;
  minutes: number;
  meridiem: string | undefined;
  now: Date;
  useUtc: boolean;
}): string {
  let hours = input.hours;
  if (hours === 12) {
    hours = 0;
  }
  if (input.meridiem === 'pm') {
    hours += 12;
  }

  const reset = new Date(input.now);
  if (input.useUtc) {
    reset.setUTCHours(hours, input.minutes, 0, 0);
    if (reset.getTime() <= input.now.getTime()) {
      reset.setUTCDate(reset.getUTCDate() + 1);
    }
  } else {
    reset.setHours(hours, input.minutes, 0, 0);
    if (reset.getTime() <= input.now.getTime()) {
      reset.setDate(reset.getDate() + 1);
    }
  }
  return reset.toISOString();
}

// CLIs report quota resets in prose, e.g. Claude's "resets 1:10am (UTC)" or
// Codex's "try again at 2:29 PM" (no zone marker at all). Only trust a time as
// UTC when the message says so explicitly; an unlabeled time is the CLI
// provider's local clock, not ours, but treating it as this machine's local
// time is the closest honest guess without a zone — better than silently
// assuming UTC and pausing for the wrong duration.
const utcResetPattern =
  /(?:resets?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(utc\)|utc)/i;
const localResetPattern = /(?:resets?|try again at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

// A cap on the exponential-backoff guess used when no reset time is reported
// (see below). Kept well under a working day so a stuck-forever pause is
// never possible even if the guess is wrong - worst case, Wake retries hourly.
const maxEstimatedPauseMs = 60 * 60_000;

export interface QuotaPauseResolution {
  pausedUntil: string;
  // 'reported' means the CLI told us the real reset time (trustworthy - no
  // need to probe early). 'estimated' means we guessed via exponential
  // backoff and don't actually know when quota resets - resolveRunnerRouting
  // uses this to allow an earlier recovery probe instead of trusting the
  // worst-case guess for its full duration (see domain/runner-routing.ts).
  source: 'reported' | 'estimated';
}

export function resolveQuotaPauseUntil(input: {
  result: string;
  now: Date;
  failureCount: number;
}): QuotaPauseResolution {
  const utcMatch = utcResetPattern.exec(input.result);
  if (utcMatch !== null) {
    return {
      pausedUntil: applyTimeOfDay({
        hours: Number(utcMatch[1]),
        minutes: Number(utcMatch[2] ?? 0),
        meridiem: utcMatch[3]?.toLowerCase(),
        now: input.now,
        useUtc: true,
      }),
      source: 'reported',
    };
  }

  const localMatch = localResetPattern.exec(input.result);
  if (localMatch !== null) {
    return {
      pausedUntil: applyTimeOfDay({
        hours: Number(localMatch[1]),
        minutes: Number(localMatch[2] ?? 0),
        meridiem: localMatch[3]?.toLowerCase(),
        now: input.now,
        useUtc: false,
      }),
      source: 'reported',
    };
  }

  const boundedFailureCount = Math.max(1, Math.min(input.failureCount, 6));
  const delayMs = Math.min(15 * 60_000 * 2 ** (boundedFailureCount - 1), maxEstimatedPauseMs);
  return {
    pausedUntil: new Date(input.now.getTime() + delayMs).toISOString(),
    source: 'estimated',
  };
}
