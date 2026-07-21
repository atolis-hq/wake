// `link` is retained for shape-compat with Octokit's response headers; it is
// never read here — single-page detection is driven by pageCount, not by
// parsing the Link header.
type ResponseHeaders = { etag?: string; link?: string };
type EtagCacheEntry<T> = { etag: string; data: T };
export type EtagCache = Map<string, EtagCacheEntry<unknown>>;

export function createEtagCache(): EtagCache {
  return new Map();
}

function isNotModifiedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 304
  );
}

export async function fetchSingleWithEtag<T>(input: {
  cache: EtagCache;
  cacheKey: string;
  request: (headers?: {
    'if-none-match': string;
  }) => Promise<{ data: T; headers: ResponseHeaders }>;
}): Promise<T> {
  const cached = input.cache.get(input.cacheKey) as EtagCacheEntry<T> | undefined;

  try {
    const response = await input.request(
      cached === undefined ? undefined : { 'if-none-match': cached.etag },
    );
    if (typeof response.headers.etag === 'string') {
      input.cache.set(input.cacheKey, { etag: response.headers.etag, data: response.data });
    }
    return response.data;
  } catch (error) {
    if (isNotModifiedError(error) && cached !== undefined) {
      return cached.data;
    }
    throw error;
  }
}

export async function fetchPaginatedWithEtag<T>(input: {
  cache: EtagCache;
  cacheKey: string;
  pages: (headers?: {
    'if-none-match': string;
  }) => AsyncIterable<{ data: T[]; headers: ResponseHeaders }>;
  maxResults?: number;
}): Promise<T[]> {
  const cached = input.cache.get(input.cacheKey) as EtagCacheEntry<T[]> | undefined;
  const results: T[] = [];
  let pageCount = 0;
  let lastHeaders: ResponseHeaders = {};

  try {
    for await (const page of input.pages(
      cached === undefined ? undefined : { 'if-none-match': cached.etag },
    )) {
      pageCount += 1;
      lastHeaders = page.headers;
      results.push(...page.data);
      if (input.maxResults !== undefined && results.length >= input.maxResults) {
        break;
      }
    }
  } catch (error) {
    if (isNotModifiedError(error) && cached !== undefined) {
      return input.maxResults === undefined ? cached.data : cached.data.slice(0, input.maxResults);
    }
    throw error;
  }

  const truncated =
    input.maxResults !== undefined && results.length > input.maxResults
      ? results.slice(0, input.maxResults)
      : results;

  if (pageCount <= 1 && typeof lastHeaders.etag === 'string') {
    input.cache.set(input.cacheKey, { etag: lastHeaders.etag, data: truncated });
  } else {
    input.cache.delete(input.cacheKey);
  }

  return truncated;
}
