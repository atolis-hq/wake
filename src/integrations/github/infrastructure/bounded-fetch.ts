const defaultMaximumGitHubResponseBytes = 8 * 1024 * 1024;

export class GitHubResponseTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedBytes: number,
  ) {
    super(`GitHub response exceeded ${maximumBytes} bytes (observed ${observedBytes})`);
    this.name = 'GitHubResponseTooLargeError';
  }
}

export function createBoundedGitHubFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  maximumResponseBytes = defaultMaximumGitHubResponseBytes,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
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
