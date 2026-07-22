import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the real @octokit/rest pipeline (unmocked, unlike
// github-client.test.ts) to verify that Octokit's built-in request-log
// plugin does not spam console.error for the 304 responses that our ETag
// caching is designed to produce, while still surfacing genuine failures.
describe('github client request logging', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not log a 304 Not Modified response as an error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 304,
        headers: { 'x-github-request-id': 'ABCD:1234' },
      }),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    // A 304 with no prior cache entry surfaces as a rejected promise from
    // Octokit; we only care that it wasn't logged as a spurious error.
    await expect(client.getRequiredStatusChecks('org', 'repo', 'main')).rejects.toBeTruthy();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still logs a genuine 500 response as an error', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'boom' }), {
        status: 500,
        headers: {
          'x-github-request-id': 'ABCD:5678',
          'content-type': 'application/json',
        },
      }),
    );

    const { createGitHubClient } = await import('../../src/adapters/github/github-client.js');
    const client = createGitHubClient('fake-token');

    await expect(client.getRequiredStatusChecks('org', 'repo', 'main')).rejects.toBeTruthy();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/ - 500 with id ABCD:5678/));
  });
});
