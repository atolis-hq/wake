import { describe, expect, it } from 'vitest';
import {
  createEtagCache,
  fetchPaginatedWithEtag,
  fetchSingleWithEtag,
} from '../../src/adapters/github/github-etag-cache.js';

function notModified(): never {
  throw { status: 304 };
}

describe('fetchSingleWithEtag', () => {
  it('caches the etag and data on the first (uncached) call', async () => {
    const cache = createEtagCache();
    const request = async (headers?: { 'if-none-match': string }) => {
      expect(headers).toBeUndefined();
      return { data: { value: 'first' }, headers: { etag: '"v1"' } };
    };

    const result = await fetchSingleWithEtag({ cache, cacheKey: 'k', request });

    expect(result).toEqual({ value: 'first' });
    expect(cache.get('k')).toEqual({ etag: '"v1"', data: { value: 'first' } });
  });

  it('sends If-None-Match on a subsequent call and returns cached data on 304', async () => {
    const cache = createEtagCache();
    cache.set('k', { etag: '"v1"', data: { value: 'cached' } });

    const request = async (headers?: { 'if-none-match': string }) => {
      expect(headers).toEqual({ 'if-none-match': '"v1"' });
      notModified();
    };

    const result = await fetchSingleWithEtag({ cache, cacheKey: 'k', request });

    expect(result).toEqual({ value: 'cached' });
  });

  it('refreshes the cache on a 200 with new data', async () => {
    const cache = createEtagCache();
    cache.set('k', { etag: '"v1"', data: { value: 'stale' } });

    const request = async () => ({ data: { value: 'fresh' }, headers: { etag: '"v2"' } });

    const result = await fetchSingleWithEtag({ cache, cacheKey: 'k', request });

    expect(result).toEqual({ value: 'fresh' });
    expect(cache.get('k')).toEqual({ etag: '"v2"', data: { value: 'fresh' } });
  });

  it('rethrows non-304 errors', async () => {
    const cache = createEtagCache();
    const request = async () => {
      throw { status: 500 };
    };

    await expect(fetchSingleWithEtag({ cache, cacheKey: 'k', request })).rejects.toEqual({
      status: 500,
    });
  });
});

describe('fetchPaginatedWithEtag', () => {
  async function* onePage(data: number[], etag: string) {
    yield { data, headers: { etag } };
  }

  async function* twoPages(first: number[], second: number[]) {
    yield { data: first, headers: { etag: '"page1"', link: '<next>; rel="next"' } };
    yield { data: second, headers: { etag: '"page2"' } };
  }

  it('caches when the whole result fits on one page', async () => {
    const cache = createEtagCache();

    const result = await fetchPaginatedWithEtag({
      cache,
      cacheKey: 'k',
      pages: () => onePage([1, 2, 3], '"v1"'),
    });

    expect(result).toEqual([1, 2, 3]);
    expect(cache.get('k')).toEqual({ etag: '"v1"', data: [1, 2, 3] });
  });

  it('does not cache (and clears any stale entry) when more than one page was fetched', async () => {
    const cache = createEtagCache();
    cache.set('k', { etag: '"stale"', data: [0] });

    const result = await fetchPaginatedWithEtag({
      cache,
      cacheKey: 'k',
      pages: () => twoPages([1, 2], [3, 4]),
    });

    expect(result).toEqual([1, 2, 3, 4]);
    expect(cache.has('k')).toBe(false);
  });

  it('stops after maxResults and still caches as single-page when the cap is hit on page 1', async () => {
    const cache = createEtagCache();

    const result = await fetchPaginatedWithEtag({
      cache,
      cacheKey: 'k',
      maxResults: 2,
      pages: () => twoPages([1, 2], [3, 4]),
    });

    expect(result).toEqual([1, 2]);
    expect(cache.get('k')).toEqual({ etag: '"page1"', data: [1, 2] });
  });

  it('returns cached data on a 304 without consuming further pages', async () => {
    const cache = createEtagCache();
    cache.set('k', { etag: '"v1"', data: [1, 2, 3] });

    async function* throwing(headers?: { 'if-none-match': string }) {
      expect(headers).toEqual({ 'if-none-match': '"v1"' });
      notModified();
      yield { data: [], headers: {} };
    }

    const result = await fetchPaginatedWithEtag({
      cache,
      cacheKey: 'k',
      pages: (headers) => throwing(headers),
    });

    expect(result).toEqual([1, 2, 3]);
  });
});
