const defaultMaximumGitHubResponseBytes = 8 * 1024 * 1024;
const defaultGitHubRequestTimeoutMs = 30_000;

export class GitHubResponseTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes: number,
  ) {
    super(`GitHub response exceeded ${maximumBytes} bytes (observed ${observedBytes})`);
    this.name = 'GitHubResponseTooLargeError';
  }
}

// Neither Octokit nor the underlying fetch implementation bounds how long a
// single request may hang: a connection that never responds (rather than
// returning a clean error status) blocks forever. Every caller of the GitHub
// client boundary — reads and mutations alike — currently awaits that call
// inline within the runner's single serialized tick, so one hung request
// stalls Advancement for every other, unrelated work item too.
export class GitHubRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`GitHub request did not complete within ${timeoutMs}ms`);
    this.name = 'GitHubRequestTimeoutError';
  }
}

export function createBoundedGitHubFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  maximumResponseBytes = defaultMaximumGitHubResponseBytes,
  timeoutMs = defaultGitHubRequestTimeoutMs,
): typeof globalThis.fetch {
  return async (input, init) => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;
    let response: Response;
    try {
      response = await baseFetch(input, { ...init, signal });
    } catch (error) {
      if (timeoutController.signal.aborted) throw new GitHubRequestTimeoutError(timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const declaredBytes = contentLength(response);
    if (declaredBytes !== undefined && declaredBytes > maximumResponseBytes) {
      await response.body?.cancel();
      throw new GitHubResponseTooLargeError(maximumResponseBytes, declaredBytes);
    }
    return new Proxy(response, {
      get(target, property) {
        if (property === 'text')
          return async () => decode(await readBoundedBody(target, maximumResponseBytes));
        if (property === 'arrayBuffer')
          return async () => (await readBoundedBody(target, maximumResponseBytes)).buffer;
        if (property === 'json')
          return async () =>
            JSON.parse(decode(await readBoundedBody(target, maximumResponseBytes)));
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get('content-length');
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return concatChunks(chunks, observedBytes);
      observedBytes += chunk.value.byteLength;
      if (observedBytes > maximumBytes) {
        await reader.cancel();
        throw new GitHubResponseTooLargeError(maximumBytes, observedBytes);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
