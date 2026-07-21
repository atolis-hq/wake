# GitHub ETag Conditional-Request Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ETag-based conditional-request caching to `src/adapters/github/github-client.ts` so that repeated polls against unchanged GitHub resources return `304 Not Modified` (which does not count against GitHub's rate limit) instead of a full, rate-limit-consuming `200` response.

**Architecture:** A small standalone cache module (`github-etag-cache.ts`) provides two generic helpers — one for single-request endpoints, one for paginated endpoints — built around an in-memory `Map<cacheKey, {etag, data}>` owned by each `createGitHubClient(token)` instance (so it persists for the lifetime of the resident process, per tick, with no cross-restart persistence required). `github-client.ts`'s existing methods are rewired to go through these helpers: each sends `If-None-Match` when a cache entry exists, and on a thrown `304` returns the cached data instead of re-fetching. For paginated endpoints, a cache entry is only written when the whole result fit in a single page — if a second page had to be fetched, the entry is deleted instead, so a stale single-page assumption can never mask a change that only shows up on page 2.

**Tech Stack:** TypeScript, `@octokit/rest` (already a dependency), Vitest.

## Global Constraints

- No behavior change from the caller's perspective: `github-issues-work-source.ts` and `github-pull-request-activity-source.ts` must not need any changes — the array/object shapes returned by `github-client.ts` methods are unchanged.
- `since`-windowed queries (`listIssues`) are still wrapped in the same caching path as everything else, even though the rolling `since` window means they will rarely hit a cache match — do not special-case them out; a mismatched `If-None-Match` is a harmless no-op (GitHub just returns a fresh `200`).
- Don't add a package dependency on `@octokit/request-error` — detect a "not modified" error by duck-typing `error.status === 304`, since that package is only a transitive dependency today.
- This is an internal adapter change with no CLI/config surface change, so no `README.md`/`docs/configuration.md` updates are required.
- Run `npm run verify` before considering the branch done (per `CLAUDE.md`).

---

### Task 1: ETag cache helper module

**Files:**
- Create: `src/adapters/github/github-etag-cache.ts`
- Test: `test/adapters/github-etag-cache.test.ts`

**Interfaces:**
- Produces: `createEtagCache(): EtagCache`, `fetchSingleWithEtag<T>(input): Promise<T>`, `fetchPaginatedWithEtag<T>(input): Promise<T[]>`, exported from `src/adapters/github/github-etag-cache.ts`. `EtagCache = Map<string, { etag: string; data: unknown }>`. Response headers are typed as `{ etag?: string; link?: string }` throughout (not `Record<string, unknown>`), matching the subset of Octokit's response headers actually used.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/adapters/github-etag-cache.test.ts
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
      // eslint-disable-next-line no-unreachable
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/adapters/github-etag-cache.test.ts`
Expected: FAIL with "Cannot find module '../../src/adapters/github/github-etag-cache.js'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/adapters/github/github-etag-cache.ts
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
  request: (
    headers?: { 'if-none-match': string },
  ) => Promise<{ data: T; headers: ResponseHeaders }>;
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
  pages: (
    headers?: { 'if-none-match': string },
  ) => AsyncIterable<{ data: T[]; headers: ResponseHeaders }>;
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
      return input.maxResults === undefined
        ? cached.data
        : cached.data.slice(0, input.maxResults);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/adapters/github-etag-cache.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github/github-etag-cache.ts test/adapters/github-etag-cache.test.ts
git commit -m "Add ETag conditional-request cache helpers for GitHub client"
```

---

### Task 2: Wire ETag caching into single-request endpoints

**Files:**
- Modify: `src/adapters/github/github-client.ts:66-96` (`getRequiredStatusChecks`, `listCheckRunsForRef`, `getCombinedStatusForRef`)
- Test: `test/adapters/github-client.test.ts`

**Interfaces:**
- Consumes: `createEtagCache`, `fetchSingleWithEtag` from Task 1 (`src/adapters/github/github-etag-cache.js`).

- [ ] **Step 1: Write the failing tests**

Add to `test/adapters/github-client.test.ts` (alongside the existing `getBranch`/`listCheckRunsForRef`/`getCombinedStatusForRef` tests — do not remove those, they should keep passing unmodified since they exercise the uncached first-call path):

```typescript
  it('sends If-None-Match on a repeat listCheckRunsForRef call and reuses cached data on 304', async () => {
    listCheckRunsForRef.mockResolvedValueOnce({
      data: { check_runs: [{ id: 1, name: 'test' }] },
      headers: { etag: '"runs-v1"' },
    });
    listCheckRunsForRef.mockRejectedValueOnce({ status: 304 });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.listCheckRunsForRef('org', 'repo', 'abc123');
    const second = await client.listCheckRunsForRef('org', 'repo', 'abc123');

    expect(listCheckRunsForRef).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      per_page: 100,
      headers: { 'if-none-match': '"runs-v1"' },
    });
    expect(second).toEqual(first);
  });

  it('sends If-None-Match on a repeat getCombinedStatusForRef call and reuses cached data on 304', async () => {
    getCombinedStatusForRef.mockResolvedValueOnce({
      data: { statuses: [{ context: 'lint', state: 'failure' }] },
      headers: { etag: '"status-v1"' },
    });
    getCombinedStatusForRef.mockRejectedValueOnce({ status: 304 });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.getCombinedStatusForRef('org', 'repo', 'abc123');
    const second = await client.getCombinedStatusForRef('org', 'repo', 'abc123');

    expect(getCombinedStatusForRef).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      headers: { 'if-none-match': '"status-v1"' },
    });
    expect(second).toEqual(first);
  });

  it('sends If-None-Match on a repeat getRequiredStatusChecks call and reuses cached data on 304', async () => {
    getBranch.mockResolvedValueOnce({
      data: {
        protection: { required_status_checks: { contexts: ['lint'], checks: [] } },
      },
      headers: { etag: '"branch-v1"' },
    });
    getBranch.mockRejectedValueOnce({ status: 304 });

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.getRequiredStatusChecks('org', 'repo', 'main');
    const second = await client.getRequiredStatusChecks('org', 'repo', 'main');

    expect(getBranch).toHaveBeenNthCalledWith(2, {
      owner: 'org',
      repo: 'repo',
      branch: 'main',
      headers: { 'if-none-match': '"branch-v1"' },
    });
    expect(second).toEqual(first);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/adapters/github-client.test.ts`
Expected: FAIL — the three new tests fail because no `If-None-Match` header is sent yet and there's no cache reuse on 304 (mocked rejection propagates as an uncaught error).

- [ ] **Step 3: Update the implementation**

Replace the top of `src/adapters/github/github-client.ts` and the three methods:

```typescript
import { Octokit } from '@octokit/rest';

import {
  createEtagCache,
  fetchPaginatedWithEtag,
  fetchSingleWithEtag,
} from './github-etag-cache.js';

export function createGitHubClient(token: string) {
  const octokit = new Octokit({ auth: token });
  const etagCache = createEtagCache();

  return {
    async getAuthenticatedLogin(): Promise<string> {
      const { data } = await octokit.rest.users.getAuthenticated();
      return data.login;
    },
```

(leave `listIssues`, `listComments`, `createComment`, `setLabels`, `getPullRequest` untouched for now — they're handled in Task 3)

```typescript
    async getRequiredStatusChecks(owner: string, repo: string, branch: string) {
      const data = await fetchSingleWithEtag({
        cache: etagCache,
        cacheKey: `required-status-checks:${owner}/${repo}@${branch}`,
        request: async (headers) => {
          const response = await octokit.rest.repos.getBranch({
            owner,
            repo,
            branch,
            ...(headers === undefined ? {} : { headers }),
          });
          return { data: response.data, headers: response.headers };
        },
      });
      const requiredStatusChecks = data.protection?.required_status_checks;
      return {
        contexts: requiredStatusChecks?.contexts ?? [],
        checks: (requiredStatusChecks?.checks ?? [])
          .map((check) => check.context)
          .filter((context): context is string => typeof context === 'string'),
      };
    },
    async listCheckRunsForRef(owner: string, repo: string, ref: string) {
      const data = await fetchSingleWithEtag({
        cache: etagCache,
        cacheKey: `check-runs:${owner}/${repo}@${ref}`,
        request: async (headers) => {
          const response = await octokit.rest.checks.listForRef({
            owner,
            repo,
            ref,
            per_page: 100,
            ...(headers === undefined ? {} : { headers }),
          });
          return { data: response.data, headers: response.headers };
        },
      });
      return data.check_runs;
    },
    async getCombinedStatusForRef(owner: string, repo: string, ref: string) {
      const data = await fetchSingleWithEtag({
        cache: etagCache,
        cacheKey: `combined-status:${owner}/${repo}@${ref}`,
        request: async (headers) => {
          const response = await octokit.rest.repos.getCombinedStatusForRef({
            owner,
            repo,
            ref,
            ...(headers === undefined ? {} : { headers }),
          });
          return { data: response.data, headers: response.headers };
        },
      });
      return data.statuses;
    },
```

Note: the existing `getBranch.mockResolvedValueOnce({ data: {...} })` (no `headers`) test still passes because `response.headers` is `undefined` there, and `typeof undefined.etag` — wait, accessing `.etag` on `undefined` throws. Guard against a missing `headers` object on the response too:

```typescript
            return { data: response.data, headers: response.headers ?? {} };
```

Apply that same `?? {}` guard in all three methods above (`getRequiredStatusChecks`, `listCheckRunsForRef`, `getCombinedStatusForRef`) so the pre-existing tests (which mock responses without a `headers` field) keep working unmodified.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/adapters/github-client.test.ts`
Expected: PASS — all pre-existing tests plus the three new ones.

- [ ] **Step 5: Run full test suite and build**

Run: `npm run build && npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github/github-client.ts test/adapters/github-client.test.ts
git commit -m "Add ETag conditional caching to check-run and status GitHub endpoints"
```

---

### Task 3: Wire ETag caching into paginated endpoints

**Files:**
- Modify: `src/adapters/github/github-client.ts:15-33,34-41,97-130` (`listIssues`, `listComments`, `listPullRequests`, `listReviews`, `listReviewComments`)
- Test: `test/adapters/github-client.test.ts`

**Interfaces:**
- Consumes: `fetchPaginatedWithEtag` from Task 1.

- [ ] **Step 1: Write the failing tests**

First, extend the `pagesOf` test helper to carry per-page headers (existing calls to `pagesOf([...], [...])` without headers keep working — headers default to `{}`):

```typescript
function pagesOf(...pages: Array<{ data: unknown[]; headers?: Record<string, unknown> }>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) {
        yield { data: page.data, headers: page.headers ?? {} };
      }
    },
  };
}
```

Update every existing call site of `pagesOf(...)` in the file to pass `{ data: [...] }` objects instead of bare arrays, e.g. `pagesOf({ data: [{ number: 5, ... }, { number: 6, ... }] })` and `pagesOf({ data: [{ number: 1 }, { number: 2 }] }, { data: [{ number: 3 }, { number: 4 }] }, { data: [{ number: 5 }, { number: 6 }] })`. This is a mechanical rewrite of the existing `pagesOf(...)` call arguments only — no assertions in those tests change.

Rewrite the `listReviews` and `listReviewComments` tests to use the iterator (mirroring how `listIssues`/`listPullRequests` are already tested), since the implementation switches from `octokit.paginate(...)` to `octokit.paginate.iterator(...)`:

```typescript
  it('lists reviews for a pull request', async () => {
    paginateIterator.mockReturnValueOnce(
      pagesOf({ data: [{ id: 1, state: 'APPROVED' }, { id: 2, state: 'REQUESTED_CHANGES' }] }),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const reviews = await client.listReviews('org', 'repo', 91, 30);

    expect(paginateIterator).toHaveBeenCalledWith(listReviews, {
      owner: 'org',
      repo: 'repo',
      pull_number: 91,
      per_page: 30,
    });
    expect(reviews).toHaveLength(2);
  });

  it('lists review comments for a pull request', async () => {
    paginateIterator.mockReturnValueOnce(
      pagesOf({ data: [{ id: 100, body: 'Comment 1' }, { id: 101, body: 'Comment 2' }] }),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const comments = await client.listReviewComments('org', 'repo', 91, 30);

    expect(paginateIterator).toHaveBeenCalledWith(listReviewComments, {
      owner: 'org',
      repo: 'repo',
      pull_number: 91,
      per_page: 30,
    });
    expect(comments).toHaveLength(2);
  });
```

Add a new `listComments` test (there wasn't one before) plus caching-behavior tests for `listIssues` and `listPullRequests`:

```typescript
  it('lists comments for an issue', async () => {
    paginateIterator.mockReturnValueOnce(
      pagesOf({ data: [{ id: 1, body: 'hi' }] }),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const comments = await client.listComments('org', 'repo', 74, 30);

    expect(paginateIterator).toHaveBeenCalledWith(expect.anything(), {
      owner: 'org',
      repo: 'repo',
      issue_number: 74,
      per_page: 30,
    });
    expect(comments).toEqual([{ id: 1, body: 'hi' }]);
  });

  it('sends If-None-Match on a repeat listPullRequests call and reuses cached data on 304', async () => {
    paginateIterator
      .mockReturnValueOnce(
        pagesOf({
          data: [{ number: 1, title: 'PR 1' }],
          headers: { etag: '"prs-v1"' },
        }),
      )
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {
          throw { status: 304 };
        },
      }));

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    const first = await client.listPullRequests('org', 'repo', 10);
    const second = await client.listPullRequests('org', 'repo', 10);

    expect(paginateIterator).toHaveBeenNthCalledWith(2, listPulls, {
      owner: 'org',
      repo: 'repo',
      state: 'open',
      per_page: 10,
      headers: { 'if-none-match': '"prs-v1"' },
    });
    expect(second).toEqual(first);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/adapters/github-client.test.ts`
Expected: FAIL — `pagesOf` shape mismatch breaks every existing paginated test until the helper and call sites are updated; the new tests fail because caching isn't wired yet and `listReviews`/`listReviewComments` still call `paginate(...)` not `paginate.iterator(...)`.

- [ ] **Step 3: Update the implementation**

Replace `listIssues`, `listComments`, `listPullRequests`, `listReviews`, `listReviewComments` in `src/adapters/github/github-client.ts`:

```typescript
    async listIssues(owner: string, repo: string, maxResults: number, since?: string) {
      const perPage = Math.min(maxResults, 100);
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `issues:${owner}/${repo}`,
        maxResults,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
            owner,
            repo,
            state: 'all',
            per_page: perPage,
            ...(since === undefined ? {} : { since }),
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async listComments(owner: string, repo: string, issueNumber: number, perPage: number) {
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `issue-comments:${owner}/${repo}#${issueNumber}`,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.issues.listComments, {
            owner,
            repo,
            issue_number: issueNumber,
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
```

```typescript
    async listPullRequests(owner: string, repo: string, maxResults: number) {
      const perPage = Math.min(maxResults, 100);
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `pulls:${owner}/${repo}`,
        maxResults,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.pulls.list, {
            owner,
            repo,
            state: 'open',
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async listReviews(owner: string, repo: string, pullNumber: number, perPage: number) {
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `pr-reviews:${owner}/${repo}#${pullNumber}`,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.pulls.listReviews, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
    async listReviewComments(owner: string, repo: string, pullNumber: number, perPage: number) {
      return fetchPaginatedWithEtag({
        cache: etagCache,
        cacheKey: `pr-review-comments:${owner}/${repo}#${pullNumber}`,
        pages: (headers) =>
          octokit.paginate.iterator(octokit.rest.pulls.listReviewComments, {
            owner,
            repo,
            pull_number: pullNumber,
            per_page: perPage,
            ...(headers === undefined ? {} : { headers }),
          }),
      });
    },
```

Leave `createComment`, `setLabels`, `getPullRequest`, `replyToReviewComment` untouched (they're mutating/single-resource calls, not in scope for conditional GET caching).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/adapters/github-client.test.ts`
Expected: PASS — all tests, including the rewritten `listReviews`/`listReviewComments` tests and the new `listComments`/caching tests.

- [ ] **Step 5: Run full test suite, lint, and build**

Run: `npm run verify`
Expected: PASS. If `format:check` flags files you didn't touch, that's the known Windows CRLF false-positive noted in `CLAUDE.md` — confirm with `npx prettier --check src/adapters/github/github-client.ts src/adapters/github/github-etag-cache.ts test/adapters/github-client.test.ts test/adapters/github-etag-cache.test.ts` that the files you actually changed are clean, writing with `npx prettier --write --end-of-line lf <file>` if not.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github/github-client.ts test/adapters/github-client.test.ts
git commit -m "Add ETag conditional caching to paginated GitHub list endpoints"
```

---

### Task 4: Final verification and PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, format:check, build, and all tests pass.

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin <branch-name>
gh pr create --title "Add ETag/conditional-request caching to GitHub polling" --body "$(cat <<'EOF'
## Summary
- Adds an in-memory ETag cache (`github-etag-cache.ts`) and wires `If-None-Match` conditional requests through the GitHub REST calls that back issue/PR polling (`listIssues`, `listComments`, `listPullRequests`, `listReviews`, `listReviewComments`, `listCheckRunsForRef`, `getCombinedStatusForRef`, `getRequiredStatusChecks`).
- A cache entry is only kept when a paginated result fit on a single page, so a stale single-page assumption can never mask a change on a later page.
- `304` responses (unchanged since last poll) don't count against GitHub's rate limit, cutting the effective per-tick request cost on quiet repos without changing any observed behavior.

Closes #284.

## Test plan
- [x] `npm run verify`
EOF
)"
```

- [ ] **Step 3: Report the PR URL to the user**

## Self-Review Notes

- **Spec coverage:** ETag cache in `github-client.ts` ✓ (Task 1). `If-None-Match` threaded through `listIssues`, `listComments`, `listPullRequests`, `listReviews`, `listReviewComments`, `listCheckRunsForRef`, `getCombinedStatusForRef` ✓ (Tasks 2–3). `getRequiredStatusChecks` (not explicitly named in the issue but same endpoint family, `getBranch`) included too ✓. 304 treated as "no change", skips re-fetching ✓ (both helpers return cached data on 304). Cache persists across ticks (module-level `Map` per client instance, lives for the resident process) ✓ — explicitly scoped to in-memory only, not restart-durable, per the issue's own "in-memory is fine" allowance.
- **Explicitly out of scope:** GraphQL batching alternative mentioned in the issue is called out there as a separate, bigger effort — not attempted here.
- **Type consistency:** `EtagCache`, `fetchSingleWithEtag<T>`, `fetchPaginatedWithEtag<T>` signatures in Task 1 are reused verbatim in Tasks 2–3.
