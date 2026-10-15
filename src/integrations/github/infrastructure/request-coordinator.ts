export interface GitHubRequestCoordinator {
  run<Value>(request: () => Promise<Value>): Promise<Value>;
}

interface GitHubRequestCoordinatorOptions {
  readonly maxConcurrent: number;
  readonly now?: () => number;
}

interface PendingRequest {
  readonly request: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class GitHubRequestCooldownError extends Error {
  constructor(readonly retryAt: number) {
    super(`GitHub provider is cooling down until ${new Date(retryAt).toISOString()}`);
    this.name = 'GitHubRequestCooldownError';
  }
}

export function createGitHubRequestCoordinator(
  options: GitHubRequestCoordinatorOptions,
): GitHubRequestCoordinator {
  return new CoordinatedGitHubRequests(options);
}

class CoordinatedGitHubRequests implements GitHubRequestCoordinator {
  private readonly queue: PendingRequest[] = [];
  private readonly now: () => number;
  private active = 0;
  private draining = false;
  private cooldownUntil = 0;
  private transientFailureCount = 0;

  constructor(private readonly options: GitHubRequestCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  run<Value>(request: () => Promise<Value>): Promise<Value> {
    return new Promise<Value>((resolve, reject) => {
      this.queue.push({
        request: request as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.active < this.options.maxConcurrent && this.queue.length > 0) {
        if (this.cooldownUntil > this.now()) {
          const error = new GitHubRequestCooldownError(this.cooldownUntil);
          this.queue.splice(0).forEach((pending) => pending.reject(error));
          return;
        }
        const pending = this.queue.shift()!;
        this.active += 1;
        void Promise.resolve()
          .then(pending.request)
          .then(
            (value) => {
              this.transientFailureCount = 0;
              pending.resolve(value);
            },
            (error: unknown) => {
              this.recordFailure(error);
              pending.reject(error);
            },
          )
          .finally(() => {
            this.active -= 1;
            void this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  private recordFailure(error: unknown): void {
    const retryAfterMs = retryAfterMilliseconds(error, this.now());
    if (isRateLimited(error)) {
      this.cooldownUntil = this.now() + (retryAfterMs ?? 60_000);
      this.transientFailureCount = 0;
      return;
    }
    if (isTransient(error)) {
      const delay = Math.min(5_000 * 2 ** this.transientFailureCount, 60_000);
      this.transientFailureCount += 1;
      this.cooldownUntil = this.now() + delay;
    }
  }
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

// Secondary rate limits arrive as 403, not 429; a plain permission 403 must not cool down.
function isRateLimited(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429) return true;
  if (status !== 403) return false;
  const headers = responseHeaders(error);
  return (
    headerValue(headers, 'retry-after') !== undefined ||
    headerValue(headers, 'x-ratelimit-remaining') === '0' ||
    (error instanceof Error && /rate limit/i.test(error.message))
  );
}

function isTransient(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== undefined) return status >= 500;
  return (
    error instanceof TypeError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string')
  );
}

function retryAfterMilliseconds(error: unknown, now: number): number | undefined {
  const value = retryAfterValue(error);
  if (value === undefined || value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function retryAfterValue(error: unknown): string | undefined {
  return headerValue(responseHeaders(error), 'retry-after');
}

function responseHeaders(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('headers' in response))
    return undefined;
  return response.headers;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    const value = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
