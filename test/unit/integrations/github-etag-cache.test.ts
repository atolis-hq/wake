import { expect, it } from 'vitest';
import {
  createEtagCache,
  fetchPaginatedWithEtag,
} from '../../../src/integrations/github/infrastructure/etag-cache.js';

it('reuses a single-page GitHub list cache after a conditional 304 response', async () => {
  const cache = createEtagCache();
  const first = await fetchPaginatedWithEtag({
    cache,
    key: 'issues:org/repo',
    pages: async function* () {
      yield { data: ['issue-1'], headers: { etag: '"v1"' } };
    },
  });
  let requestHeaders: { readonly 'if-none-match': string } | undefined;
  const second = await fetchPaginatedWithEtag({
    cache,
    key: 'issues:org/repo',
    pages: (headers) => ({
      // eslint-disable-next-line require-yield -- intentionally throws before any yield to exercise the 304 path
      async *[Symbol.asyncIterator]() {
        requestHeaders = headers;
        throw Object.assign(new Error('not modified'), { status: 304 });
      },
    }),
  });

  expect(first).toEqual(['issue-1']);
  expect(requestHeaders).toEqual({ 'if-none-match': '"v1"' });
  expect(second).toEqual(['issue-1']);
});
