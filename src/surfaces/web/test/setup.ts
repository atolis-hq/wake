import { afterEach, vi } from 'vitest';

// Component tests exercise the already-authenticated operator experience.
// Login itself is covered by the auth HTTP and application tests.
vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
  if (String(input) === '/api/v1/auth/session')
    return new Response(JSON.stringify({ authenticated: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  throw new Error(`Unexpected browser fetch: ${String(input)}`);
});

afterEach(() => vi.clearAllMocks());
