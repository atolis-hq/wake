export interface AdapterHealth {
  readonly status: 'ok' | 'degraded';
  readonly detail?: string;
  readonly successCount: number;
  readonly failureCount: number;
}

export interface AdapterHealthTracker {
  recordSuccess(): void;
  recordFailure(error: unknown): void;
  snapshot(): AdapterHealth;
}

interface AdapterHealthTrackerOptions {
  readonly now?: () => number;
  readonly degradeAfterConsecutiveFailures?: number;
}

const DEFINITIVE_STATUSES = new Set([401, 403, 429]);

export function createAdapterHealthTracker(
  options: AdapterHealthTrackerOptions = {},
): AdapterHealthTracker {
  const now = options.now ?? Date.now;
  const threshold = options.degradeAfterConsecutiveFailures ?? 3;

  let successCount = 0;
  let failureCount = 0;
  let consecutiveFailures = 0;
  let degradedDetail: string | undefined;

  return {
    recordSuccess() {
      successCount += 1;
      consecutiveFailures = 0;
      degradedDetail = undefined;
    },
    recordFailure(error: unknown) {
      failureCount += 1;
      consecutiveFailures += 1;
      const status = statusOf(error);
      const occurredAt = new Date(now()).toISOString();
      const message = error instanceof Error ? error.message : String(error);
      if (status !== undefined && DEFINITIVE_STATUSES.has(status)) {
        degradedDetail = `${status} at ${occurredAt}: ${message}`;
        return;
      }
      if (consecutiveFailures >= threshold) {
        degradedDetail = `${consecutiveFailures} consecutive failures, last: ${
          status ?? 'error'
        } at ${occurredAt}: ${message}`;
      }
    },
    snapshot(): AdapterHealth {
      return {
        status: degradedDetail === undefined ? 'ok' : 'degraded',
        ...(degradedDetail === undefined ? {} : { detail: degradedDetail }),
        successCount,
        failureCount,
      };
    },
  };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}
