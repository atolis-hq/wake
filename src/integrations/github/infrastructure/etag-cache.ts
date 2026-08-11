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

export async function fetchPaginatedWithEtag<T>(input: {
  readonly cache: EtagCache;
  readonly key: string;
  readonly maxResults?: number;
  readonly pages: (headers?: { readonly 'if-none-match': string }) => AsyncIterable<{
    readonly data: readonly T[];
    readonly headers?: { readonly etag?: string };
  }>;
}): Promise<readonly T[]> {
  const cached = input.cache.get(input.key) as
    { readonly etag: string; readonly data: readonly T[] } | undefined;
  const values: T[] = [];
  let pages = 0;
  let etag: string | undefined;
  try {
    for await (const page of input.pages(
      cached === undefined ? undefined : { 'if-none-match': cached.etag },
    )) {
      pages += 1;
      etag = page.headers?.etag;
      values.push(...page.data);
      if (reachedLimit(values.length, input.maxResults)) break;
    }
  } catch (error) {
    const notModified = cached !== undefined && status(error) === 304;
    if (!notModified) throw error;
    return truncate(cached.data, input.maxResults);
  }
  const data = truncate(values, input.maxResults);
  if (pages <= 1 && etag !== undefined) input.cache.set(input.key, { etag, data });
  else input.cache.delete(input.key);
  return data;
}

function reachedLimit(count: number, maxResults: number | undefined): boolean {
  return maxResults !== undefined && count >= maxResults;
}

function truncate<T>(values: readonly T[], maxResults: number | undefined): readonly T[] {
  return maxResults === undefined ? values : values.slice(0, maxResults);
}

function status(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : undefined;
}
