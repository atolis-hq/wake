type EtagCache = Map<string, { readonly etag: string; readonly data: unknown }>;

export const createEtagCache = (): EtagCache => new Map();

export async function fetchWithEtag<T>(input: {
  readonly cache: EtagCache;
  readonly key: string;
  readonly request: (headers?: {
    readonly 'if-none-match': string;
  }) => Promise<{ readonly data: T; readonly etag?: string }>;
}): Promise<T> {
  const cached = input.cache.get(input.key) as
    { readonly etag: string; readonly data: T } | undefined;
  try {
    const response = await input.request(
      cached === undefined ? undefined : { 'if-none-match': cached.etag },
    );
    if (response.etag !== undefined)
      input.cache.set(input.key, { etag: response.etag, data: response.data });
    return response.data;
  } catch (error) {
    if (status(error) === 304 && cached !== undefined) return cached.data;
    throw error;
  }
}

function status(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : undefined;
}
