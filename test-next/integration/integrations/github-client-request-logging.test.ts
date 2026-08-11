import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGitHubClient,
  redactGitHubRequestMessage,
} from '../../../src-next/integrations/github/infrastructure/client.js';

describe('GitHub client request logging', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    stderr.mockRestore();
  });

  it.each([429, 500])(
    'logs and preserves a real GitHub %i failure without exposing the configured token',
    async (status) => {
      fetch.mockResolvedValueOnce(githubFailure(status, 'ABCD:1234'));
      const client = createGitHubClient('ghp_configured_token');

      await expect(client.authenticatedLogin()).rejects.toMatchObject({
        status,
        message: 'upstream failure',
      });

      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(`GET /user - ${status} with id ABCD:1234`),
      );
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('ghp_configured_token'));
    },
  );

  it('keeps a real GitHub 304 request failure quiet', async () => {
    fetch.mockResolvedValueOnce(githubFailure(304, 'ABCD:304'));
    const client = createGitHubClient('ghp_configured_token');

    await expect(client.authenticatedLogin()).rejects.toMatchObject({ status: 304 });

    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    'GET /user - 500 with id A:1 authorization: Basic dXNlcjpnaHBfYmFzaWNfc2VjcmV0',
    'GET /user - 500 with id A:1 authorization: token ghp_token_secret',
    'GET /user?access_token=ghp_access_secret - 500 with id A:1',
    'GET /user?token=ghp_query_token&authorization=Bearer%20ghp_query_bearer - 500 with id A:1',
  ])('redacts credentials from diagnostic message %s', (message) => {
    const redacted = redactGitHubRequestMessage(message);

    expect(redacted).toContain('500 with id A:1');
    expect(redacted).not.toMatch(/(?:Basic\s|token\s|ghp_|Bearer)/i);
  });
});

function githubFailure(status: number, requestId: string): Response {
  return new Response(status === 304 ? null : JSON.stringify({ message: 'upstream failure' }), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
    },
  });
}
